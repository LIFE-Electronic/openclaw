import crypto from "node:crypto";
import { SILENT_REPLY_TOKEN } from "../../auto-reply/tokens.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { clearAgentRunContext, registerAgentRunContext } from "../../infra/agent-events.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import {
  completeTaskRunByRunId,
  createRunningTaskRun,
  failTaskRunByRunId,
  recordTaskRunProgressByRunId,
} from "../../tasks/detached-task-runtime.js";
import { normalizeDeliveryContext, type DeliveryContext } from "../../utils/delivery-context.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isDeliverableMessageChannel,
  isInternalMessageChannel,
} from "../../utils/message-channel.js";
import {
  mediaUrlsFromGeneratedAttachments,
  type AgentGeneratedAttachment,
} from "../generated-attachments.js";
import { captureMediaIdentities } from "../generated-media-identity.js";
import { formatAgentInternalEventsForPrompt, type AgentInternalEvent } from "../internal-events.js";
import { deliverSubagentAnnouncement } from "../subagent-announce-delivery.js";

const log = createSubsystemLogger("agents/tools/media-generate-background-shared");
const MEDIA_GENERATION_TASK_KEEPALIVE_INTERVAL_MS = 60_000;

export type MediaGenerationTaskHandle = {
  taskId: string;
  runId: string;
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
  taskLabel: string;
};

export type MediaGenerateBackgroundScheduler = (work: () => Promise<void>) => void;

export type MediaGenerateAsyncStartCallback = (message: string) => Promise<void> | void;

export type MediaGenerationExecutionResult = {
  provider: string;
  model: string;
  count: number;
  paths: string[];
  wakeResult: string;
  attachments?: AgentGeneratedAttachment[];
  mediaUrls?: string[];
};

type CreateMediaGenerationTaskRunParams = {
  sessionKey?: string;
  requesterOrigin?: DeliveryContext;
  prompt: string;
  providerId?: string;
};

type RecordMediaGenerationTaskProgressParams = {
  handle: MediaGenerationTaskHandle | null;
  progressSummary: string;
  eventSummary?: string;
};

type CompleteMediaGenerationTaskRunParams = {
  handle: MediaGenerationTaskHandle | null;
  provider: string;
  model: string;
  count: number;
  paths: string[];
};

type FailMediaGenerationTaskRunParams = {
  handle: MediaGenerationTaskHandle | null;
  error: unknown;
};

type WakeMediaGenerationTaskCompletionParams = {
  config?: OpenClawConfig;
  handle: MediaGenerationTaskHandle | null;
  status: "ok" | "error";
  statusLabel: string;
  result: string;
  attachments?: AgentGeneratedAttachment[];
  mediaUrls?: string[];
  statsLine?: string;
};

type MediaGenerationTaskLifecycle = {
  createTaskRun: (params: CreateMediaGenerationTaskRunParams) => MediaGenerationTaskHandle | null;
  recordTaskProgress: (params: RecordMediaGenerationTaskProgressParams) => void;
  completeTaskRun: (params: CompleteMediaGenerationTaskRunParams) => void;
  failTaskRun: (params: FailMediaGenerationTaskRunParams) => void;
  wakeTaskCompletion: (params: WakeMediaGenerationTaskCompletionParams) => Promise<boolean>;
};

function touchMediaGenerationTaskRunContext(handle: MediaGenerationTaskHandle) {
  registerAgentRunContext(handle.runId, {
    sessionKey: handle.requesterSessionKey,
    lastActiveAt: Date.now(),
  });
}

function createMediaGenerationTaskRun(params: {
  sessionKey?: string;
  requesterOrigin?: DeliveryContext;
  prompt: string;
  providerId?: string;
  toolName: string;
  taskKind: string;
  label: string;
  queuedProgressSummary: string;
}): MediaGenerationTaskHandle | null {
  const sessionKey = params.sessionKey?.trim();
  if (!sessionKey) {
    return null;
  }
  const runId = `tool:${params.toolName}:${crypto.randomUUID()}`;
  try {
    const task = createRunningTaskRun({
      runtime: "cli",
      taskKind: params.taskKind,
      sourceId: params.providerId ? `${params.toolName}:${params.providerId}` : params.toolName,
      requesterSessionKey: sessionKey,
      ownerKey: sessionKey,
      scopeKind: "session",
      requesterOrigin: params.requesterOrigin,
      childSessionKey: sessionKey,
      runId,
      label: params.label,
      task: params.prompt,
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
      startedAt: Date.now(),
      lastEventAt: Date.now(),
      progressSummary: params.queuedProgressSummary,
    });
    const handle = {
      taskId: task.taskId,
      runId,
      requesterSessionKey: sessionKey,
      requesterOrigin: params.requesterOrigin,
      taskLabel: params.prompt,
    };
    touchMediaGenerationTaskRunContext(handle);
    return handle;
  } catch (error) {
    log.warn("Failed to create media generation task ledger record", {
      sessionKey,
      toolName: params.toolName,
      providerId: params.providerId,
      error,
    });
    return null;
  }
}

function recordMediaGenerationTaskProgress(params: {
  handle: MediaGenerationTaskHandle | null;
  progressSummary: string;
  eventSummary?: string;
}) {
  if (!params.handle) {
    return;
  }
  touchMediaGenerationTaskRunContext(params.handle);
  recordTaskRunProgressByRunId({
    runId: params.handle.runId,
    runtime: "cli",
    sessionKey: params.handle.requesterSessionKey,
    lastEventAt: Date.now(),
    progressSummary: params.progressSummary,
    eventSummary: params.eventSummary,
  });
}

export async function withMediaGenerationTaskKeepalive<T>(params: {
  handle: MediaGenerationTaskHandle | null;
  progressSummary: string;
  eventSummary?: string;
  run: () => Promise<T>;
}): Promise<T> {
  if (!params.handle) {
    return await params.run();
  }
  const interval = setInterval(() => {
    recordMediaGenerationTaskProgress({
      handle: params.handle,
      progressSummary: params.progressSummary,
      eventSummary: params.eventSummary,
    });
  }, MEDIA_GENERATION_TASK_KEEPALIVE_INTERVAL_MS);
  interval.unref?.();
  try {
    return await params.run();
  } finally {
    clearInterval(interval);
  }
}

function completeMediaGenerationTaskRun(params: {
  handle: MediaGenerationTaskHandle | null;
  provider: string;
  model: string;
  count: number;
  paths: string[];
  generatedLabel: string;
}) {
  if (!params.handle) {
    return;
  }
  try {
    const endedAt = Date.now();
    const target = params.count === 1 ? params.paths[0] : `${params.count} files`;
    completeTaskRunByRunId({
      runId: params.handle.runId,
      runtime: "cli",
      sessionKey: params.handle.requesterSessionKey,
      endedAt,
      lastEventAt: endedAt,
      progressSummary: `Generated ${params.count} ${params.generatedLabel}${params.count === 1 ? "" : "s"}`,
      terminalSummary: `Generated ${params.count} ${params.generatedLabel}${params.count === 1 ? "" : "s"} with ${params.provider}/${params.model}${target ? ` -> ${target}` : ""}.`,
    });
  } finally {
    clearAgentRunContext(params.handle.runId);
  }
}

function failMediaGenerationTaskRun(params: {
  handle: MediaGenerationTaskHandle | null;
  error: unknown;
  progressSummary: string;
}) {
  if (!params.handle) {
    return;
  }
  try {
    const endedAt = Date.now();
    const errorText = formatErrorMessage(params.error);
    failTaskRunByRunId({
      runId: params.handle.runId,
      runtime: "cli",
      sessionKey: params.handle.requesterSessionKey,
      endedAt,
      lastEventAt: endedAt,
      error: errorText,
      progressSummary: params.progressSummary,
      terminalSummary: errorText,
    });
  } finally {
    clearAgentRunContext(params.handle.runId);
  }
}

function buildMediaGenerationReplyInstruction(params: {
  status: "ok" | "error";
  completionLabel: string;
  requesterOrigin?: DeliveryContext;
}) {
  // Background events use an internal source channel even for external chats;
  // the saved requester route is the authority for visible reply delivery.
  if (isInternalMessageChannel(params.requesterOrigin?.channel)) {
    return params.status === "ok"
      ? `The ${params.completionLabel} is ready. Send a normal visible assistant final reply in the original Webchat with a short caption and every generated attachment, using MEDIA:<absolute-local-path> on its own line. Use the original generated paths or byte-identical workspace copies. Do not use the message tool or infer a Telegram/other external target from the session key.`
      : `${params.completionLabel} generation failed. Send the failure summary as a normal visible assistant final reply in the original Webchat. Keep internal task/session details private. Do not use the message tool or infer an external target.`;
  }
  if (params.status === "ok") {
    return [
      `The ${params.completionLabel} is ready for the original chat.`,
      "This route requires message-tool delivery: the user will NOT see your normal assistant final reply.",
      'Call the message tool with action="send" to the original/current chat, put a short caption in the message, and attach every structured attachment from the internal event using its original generated path (a separate workspace copy is fine).',
      `After the message tool succeeds, reply only ${SILENT_REPLY_TOKEN}.`,
      "Do not rely on text-only output; the media must be sent as message-tool attachments.",
    ].join(" ");
  }
  return [
    `${params.completionLabel[0]?.toUpperCase() ?? "T"}${params.completionLabel.slice(1)} generation task failed for the original chat.`,
    "This route requires message-tool delivery: the user will NOT see your normal assistant final reply.",
    'Call the message tool with action="send" to the original/current chat and put the failure summary in the message.',
    `After the message tool succeeds, reply only ${SILENT_REPLY_TOKEN}.`,
    "Keep internal task/session details private and do not copy the internal event text verbatim.",
  ].join(" ");
}

export function createDefaultMediaGenerateBackgroundScheduler(params: {
  toolName: string;
  onCrash: (message: string, meta?: Record<string, unknown>) => void;
}): MediaGenerateBackgroundScheduler {
  return (work) => {
    queueMicrotask(() => {
      void work().catch((error) => {
        params.onCrash(`Detached ${params.toolName} job crashed`, { error });
      });
    });
  };
}

export function buildMediaGenerationStartedToolResult(params: {
  toolName: string;
  generationLabel: string;
  completionLabel: string;
  taskHandle: MediaGenerationTaskHandle | null;
  detailExtras?: Record<string, unknown>;
  messages?: Array<string | undefined>;
}) {
  return {
    content: [
      {
        type: "text" as const,
        text: [
          `Background task started for ${params.generationLabel} generation (${params.taskHandle?.taskId ?? "unknown"}). Do not call ${params.toolName} again for this request. Wait for the completion event; the completion agent will send the finished ${params.completionLabel} here when it's ready.`,
          ...(params.messages ?? []),
        ]
          .filter((entry): entry is string => Boolean(entry))
          .join("\n"),
      },
    ],
    details: {
      async: true,
      status: "started",
      ...(params.taskHandle
        ? {
            taskId: params.taskHandle.taskId,
            runId: params.taskHandle.runId,
            task: {
              taskId: params.taskHandle.taskId,
              runId: params.taskHandle.runId,
            },
          }
        : {}),
      ...params.detailExtras,
    },
    terminate: true,
  };
}

export async function notifyMediaGenerationAsyncTaskStarted(params: {
  callback?: MediaGenerateAsyncStartCallback;
  message: string;
  toolName: string;
  handle: MediaGenerationTaskHandle | null;
  onFailure: (message: string, meta?: Record<string, unknown>) => void;
}) {
  if (!params.callback) {
    return;
  }
  try {
    await params.callback(params.message);
  } catch (error) {
    params.onFailure("Media generation async-start callback failed", {
      toolName: params.toolName,
      taskId: params.handle?.taskId,
      runId: params.handle?.runId,
      error,
    });
  }
}

export function scheduleMediaGenerationTaskCompletion<
  T extends MediaGenerationExecutionResult,
>(params: {
  lifecycle: MediaGenerationTaskLifecycle;
  handle: MediaGenerationTaskHandle | null;
  scheduleBackgroundWork: MediaGenerateBackgroundScheduler;
  progressSummary: string;
  config?: OpenClawConfig;
  toolName: string;
  run: () => Promise<T>;
  onWakeFailure: (message: string, meta?: Record<string, unknown>) => void;
}) {
  params.scheduleBackgroundWork(async () => {
    try {
      const executed = await withMediaGenerationTaskKeepalive({
        handle: params.handle,
        progressSummary: params.progressSummary,
        run: params.run,
      });
      params.lifecycle.recordTaskProgress({
        handle: params.handle,
        progressSummary: "Generated media; delivering completion",
      });
      let completionDelivered = false;
      try {
        completionDelivered = await params.lifecycle.wakeTaskCompletion({
          config: params.config,
          handle: params.handle,
          status: "ok",
          statusLabel: "completed successfully",
          result: executed.wakeResult,
          attachments: executed.attachments,
          mediaUrls: executed.mediaUrls,
        });
      } catch (error) {
        params.onWakeFailure(
          `${params.toolName} completion wake failed after successful generation`,
          {
            taskId: params.handle?.taskId,
            runId: params.handle?.runId,
            error,
          },
        );
      }
      if (!completionDelivered) {
        throw new Error(
          `${params.toolName} completion delivery failed after successful generation`,
        );
      }
      params.lifecycle.completeTaskRun({
        handle: params.handle,
        provider: executed.provider,
        model: executed.model,
        count: executed.count,
        paths: executed.paths,
      });
    } catch (error) {
      params.lifecycle.failTaskRun({
        handle: params.handle,
        error,
      });
      await params.lifecycle.wakeTaskCompletion({
        config: params.config,
        handle: params.handle,
        status: "error",
        statusLabel: "failed",
        result: formatErrorMessage(error),
      });
    }
  });
}

async function wakeMediaGenerationTaskCompletion(params: {
  config?: OpenClawConfig;
  handle: MediaGenerationTaskHandle | null;
  status: "ok" | "error";
  statusLabel: string;
  result: string;
  attachments?: AgentGeneratedAttachment[];
  mediaUrls?: string[];
  statsLine?: string;
  eventSource: AgentInternalEvent["source"];
  announceType: string;
  toolName: string;
  completionLabel: string;
}): Promise<boolean> {
  if (!params.handle) {
    return true;
  }
  const announceId = `${params.toolName}:${params.handle.taskId}:${params.status}`;
  const mediaUrls = Array.from(
    new Set([
      ...(params.mediaUrls ?? []),
      ...mediaUrlsFromGeneratedAttachments(params.attachments),
    ]),
  );
  // Freeze generated bytes before the completion turn can copy or edit them.
  const mediaIdentities = params.status === "ok" ? await captureMediaIdentities(mediaUrls) : [];
  const internalEvents: AgentInternalEvent[] = [
    {
      type: "task_completion",
      source: params.eventSource,
      childSessionKey: `${params.toolName}:${params.handle.taskId}`,
      childSessionId: params.handle.taskId,
      announceType: params.announceType,
      taskLabel: params.handle.taskLabel,
      status: params.status,
      statusLabel: params.statusLabel,
      result: params.result,
      ...(params.attachments?.length ? { attachments: params.attachments } : {}),
      ...(mediaUrls.length ? { mediaUrls } : {}),
      ...(mediaIdentities.length ? { mediaIdentities } : {}),
      ...(params.statsLine?.trim() ? { statsLine: params.statsLine } : {}),
      replyInstruction: buildMediaGenerationReplyInstruction({
        status: params.status,
        completionLabel: params.completionLabel,
        requesterOrigin: params.handle.requesterOrigin,
      }),
    },
  ];
  const triggerMessage =
    formatAgentInternalEventsForPrompt(internalEvents) ||
    `A ${params.completionLabel} generation task finished. Process the completion update now.`;
  const delivery = await deliverSubagentAnnouncement({
    requesterSessionKey: params.handle.requesterSessionKey,
    targetRequesterSessionKey: params.handle.requesterSessionKey,
    announceId,
    triggerMessage,
    steerMessage: triggerMessage,
    internalEvents,
    summaryLine: params.handle.taskLabel,
    requesterSessionOrigin: params.handle.requesterOrigin,
    requesterOrigin: params.handle.requesterOrigin,
    completionDirectOrigin: params.handle.requesterOrigin,
    directOrigin: params.handle.requesterOrigin,
    sourceSessionKey: `${params.toolName}:${params.handle.taskId}`,
    sourceChannel: INTERNAL_MESSAGE_CHANNEL,
    sourceTool: params.toolName,
    requesterIsSubagent: false,
    expectsCompletionMessage: true,
    bestEffortDeliver: true,
    directIdempotencyKey: announceId,
  });
  if (delivery.delivered) {
    log.info("Media generation completion delivery verified", {
      taskId: params.handle.taskId,
      runId: params.handle.runId,
      status: params.status,
      channel: params.handle.requesterOrigin?.channel,
    });
    return true;
  }
  if (params.status === "error") {
    const delivered = await tryDeliverMediaGenerationFailureDirect({
      config: params.config,
      handle: params.handle,
      toolName: params.toolName,
      completionLabel: params.completionLabel,
      result: params.result,
    });
    if (delivered) {
      return true;
    }
  }
  if (delivery.error) {
    log.error("Media generation completion wake failed; requester session was not woken", {
      taskId: params.handle.taskId,
      runId: params.handle.runId,
      toolName: params.toolName,
      error: delivery.error,
    });
  }
  return false;
}

async function tryDeliverMediaGenerationFailureDirect(params: {
  config?: OpenClawConfig;
  handle: MediaGenerationTaskHandle;
  toolName: string;
  completionLabel: string;
  result: string;
}): Promise<boolean> {
  const origin = normalizeDeliveryContext(params.handle.requesterOrigin);
  if (!origin?.channel || !origin.to || !isDeliverableMessageChannel(origin.channel)) {
    return false;
  }
  const label = `${params.completionLabel[0]?.toUpperCase() ?? "M"}${params.completionLabel.slice(1)}`;
  const agentId = resolveAgentIdFromSessionKey(params.handle.requesterSessionKey);
  const idempotencyKey = `${params.toolName}:${params.handle.taskId}:error:direct`;
  try {
    const { sendMessage } = await import("../../tasks/task-registry-delivery-runtime.js");
    await sendMessage({
      cfg: params.config,
      channel: origin.channel,
      to: origin.to,
      accountId: origin.accountId,
      threadId: origin.threadId,
      content: `${label} generation failed: ${params.result}`,
      requesterSessionKey: params.handle.requesterSessionKey,
      agentId,
      idempotencyKey,
      mirror: {
        sessionKey: params.handle.requesterSessionKey,
        agentId,
        idempotencyKey,
      },
    });
    return true;
  } catch (error) {
    log.warn("Direct media generation failure delivery failed; falling back to agent wake", {
      taskId: params.handle.taskId,
      runId: params.handle.runId,
      toolName: params.toolName,
      error,
    });
    return false;
  }
}

export function createMediaGenerationTaskLifecycle(params: {
  toolName: string;
  taskKind: string;
  label: string;
  queuedProgressSummary: string;
  generatedLabel: string;
  failureProgressSummary: string;
  eventSource: AgentInternalEvent["source"];
  announceType: string;
  completionLabel: string;
}): MediaGenerationTaskLifecycle {
  return {
    createTaskRun(runParams: CreateMediaGenerationTaskRunParams): MediaGenerationTaskHandle | null {
      return createMediaGenerationTaskRun({
        ...runParams,
        toolName: params.toolName,
        taskKind: params.taskKind,
        label: params.label,
        queuedProgressSummary: params.queuedProgressSummary,
      });
    },

    recordTaskProgress(progressParams: RecordMediaGenerationTaskProgressParams) {
      recordMediaGenerationTaskProgress(progressParams);
    },

    completeTaskRun(completionParams: CompleteMediaGenerationTaskRunParams) {
      completeMediaGenerationTaskRun({
        ...completionParams,
        generatedLabel: params.generatedLabel,
      });
    },

    failTaskRun(failureParams: FailMediaGenerationTaskRunParams) {
      failMediaGenerationTaskRun({
        ...failureParams,
        progressSummary: params.failureProgressSummary,
      });
    },

    async wakeTaskCompletion(completionParams: WakeMediaGenerationTaskCompletionParams) {
      return await wakeMediaGenerationTaskCompletion({
        ...completionParams,
        eventSource: params.eventSource,
        announceType: params.announceType,
        toolName: params.toolName,
        completionLabel: params.completionLabel,
      });
    },
  };
}
