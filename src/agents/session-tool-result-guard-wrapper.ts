import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import {
  applyInputProvenanceToUserMessage,
  type InputProvenance,
} from "../sessions/input-provenance.js";
import {
  mergePreparedUserTurnMessageForRuntime,
  type PersistedUserTurnMessage,
} from "../sessions/user-turn-transcript.js";
import { resolveLiveToolResultMaxChars } from "./embedded-agent-runner/tool-result-truncation.js";
import type { AgentMessage } from "./runtime/index.js";
import { installSessionToolResultGuard } from "./session-tool-result-guard.js";
import type { SessionManager } from "./sessions/index.js";
import { redactTranscriptMessage } from "./transcript-redact.js";

type GuardedSessionManager = SessionManager & {
  /** Flush any synthetic tool results for pending tool calls. Idempotent. */
  flushPendingToolResults?: () => void;
  /** Clear pending tool calls without persisting synthetic tool results. Idempotent. */
  clearPendingToolResults?: () => void;
};

/**
 * Apply the tool-result guard to a SessionManager exactly once and expose
 * a flush method on the instance for easy teardown handling.
 */
export function guardSessionManager(
  sessionManager: SessionManager,
  opts?: {
    agentId?: string;
    sessionKey?: string;
    heartbeatRunId?: string;
    backgroundExecution?: import("../infra/wolper-background.js").BackgroundExecution;
    config?: OpenClawConfig;
    contextWindowTokens?: number;
    inputProvenance?: InputProvenance;
    allowSyntheticToolResults?: boolean;
    missingToolResultText?: string;
    allowedToolNames?: Iterable<string>;
    preparedUserTurnMessage?: PersistedUserTurnMessage;
    suppressNextUserMessagePersistence?: boolean;
    suppressTranscriptOnlyAssistantPersistence?: boolean;
    suppressAssistantErrorPersistence?: boolean;
    onUserMessagePersisted?: (
      message: Extract<AgentMessage, { role: "user" }>,
    ) => void | Promise<void>;
    onMessagePersisted?: (message: AgentMessage) => void | Promise<void>;
    onAssistantErrorMessagePersisted?: (
      message: Extract<AgentMessage, { role: "assistant" }>,
    ) => void | Promise<void>;
  },
): GuardedSessionManager {
  if (typeof (sessionManager as GuardedSessionManager).flushPendingToolResults === "function") {
    return sessionManager as GuardedSessionManager;
  }

  const hookRunner = getGlobalHookRunner();
  let pendingPreparedUserTurnMessage = opts?.preparedUserTurnMessage;
  const beforeMessageWrite = (event: { message: AgentMessage }) => {
    let message = event.message;
    let changed = false;
    if (hookRunner?.hasHooks("before_message_write")) {
      const result = hookRunner.runBeforeMessageWrite(event, {
        agentId: opts?.agentId,
        sessionKey: opts?.sessionKey,
      });
      if (result?.block) {
        return result;
      }
      if (result?.message) {
        message = result.message;
        changed = true;
      }
    }
    const redacted = redactTranscriptMessage(message, opts?.config);
    if (redacted !== message) {
      message = redacted;
      changed = true;
    }
    // Heartbeats suppress live deltas/lifecycle on interactive chat surfaces.
    // Persist their native run identity so transcript and final events join
    // even after a subscriber reconnects; never infer identity from text.
    const execution = opts?.backgroundExecution;
    if (message.role === "assistant" && execution) {
      const previous = (message as AgentMessage & { __openclaw?: unknown })["__openclaw"];
      message = {
        ...message,
        __openclaw: {
          ...(previous && typeof previous === "object" && !Array.isArray(previous) ? previous : {}),
          runId: execution.runId,
          origin: execution.origin,
          ...(execution.origin.is_heartbeat ? { isHeartbeat: true } : {}),
        },
      } as AgentMessage;
      changed = true;
    }
    const heartbeatRunId = opts?.heartbeatRunId?.trim();
    if (message.role === "assistant" && heartbeatRunId) {
      const previous = (message as AgentMessage & { __openclaw?: unknown })["__openclaw"];
      const identified = {
        ...message,
        __openclaw: {
          ...(previous && typeof previous === "object" && !Array.isArray(previous) ? previous : {}),
          runId: heartbeatRunId,
          isHeartbeat: true,
        },
      };
      message = identified;
      changed = true;
    }
    return changed ? { message } : undefined;
  };

  const transform = hookRunner?.hasHooks("tool_result_persist")
    ? (
        message: AgentMessage,
        meta: { toolCallId?: string; toolName?: string; isSynthetic?: boolean },
      ) => {
        const out = hookRunner.runToolResultPersist(
          {
            toolName: meta.toolName,
            toolCallId: meta.toolCallId,
            message,
            isSynthetic: meta.isSynthetic,
          },
          {
            agentId: opts?.agentId,
            sessionKey: opts?.sessionKey,
            toolName: meta.toolName,
            toolCallId: meta.toolCallId,
          },
        );
        return out?.message ?? message;
      }
    : undefined;

  const guard = installSessionToolResultGuard(sessionManager, {
    sessionKey: opts?.sessionKey,
    transformMessageForPersistence: (message) => {
      const withProvenance = applyInputProvenanceToUserMessage(message, opts?.inputProvenance);
      const prepared = pendingPreparedUserTurnMessage;
      const merged = mergePreparedUserTurnMessageForRuntime({
        runtimeMessage: withProvenance,
        ...(prepared ? { preparedMessage: prepared } : {}),
      });
      if (merged !== withProvenance) {
        pendingPreparedUserTurnMessage = undefined;
      }
      return merged;
    },
    transformToolResultForPersistence: transform,
    allowSyntheticToolResults: opts?.allowSyntheticToolResults,
    missingToolResultText: opts?.missingToolResultText,
    allowedToolNames: opts?.allowedToolNames,
    beforeMessageWriteHook: beforeMessageWrite,
    redactLoggingConfig: opts?.config?.logging,
    maxToolResultChars:
      typeof opts?.contextWindowTokens === "number"
        ? resolveLiveToolResultMaxChars({
            contextWindowTokens: opts.contextWindowTokens,
            cfg: opts.config,
            agentId: opts.agentId,
          })
        : undefined,
    suppressNextUserMessagePersistence: opts?.suppressNextUserMessagePersistence,
    suppressTranscriptOnlyAssistantPersistence: opts?.suppressTranscriptOnlyAssistantPersistence,
    suppressAssistantErrorPersistence: opts?.suppressAssistantErrorPersistence,
    onMessagePersisted: opts?.onMessagePersisted,
    onUserMessagePersisted: opts?.onUserMessagePersisted,
    onAssistantErrorMessagePersisted: opts?.onAssistantErrorMessagePersisted,
  });
  (sessionManager as GuardedSessionManager).flushPendingToolResults = guard.flushPendingToolResults;
  (sessionManager as GuardedSessionManager).clearPendingToolResults = guard.clearPendingToolResults;
  return sessionManager as GuardedSessionManager;
}
