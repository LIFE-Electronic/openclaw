import { formatErrorMessage } from "../infra/errors.js";
import type { MediaCompletionDelivery } from "../infra/session-delivery-queue-storage.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { setDetachedTaskDeliveryStatusByRunId } from "../tasks/detached-task-runtime.js";
import { getTaskById } from "../tasks/runtime-internal.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel.js";
import {
  isEmbeddedAgentRunActive,
  resolveActiveEmbeddedRunSessionId,
} from "./embedded-agent-runner/runs.js";
import { formatAgentInternalEventsForPrompt } from "./internal-events.js";
import { createMediaCompletionQueue } from "./media-completion-queue.js";
import {
  deliverSubagentAnnouncement,
  loadRequesterSessionEntry,
} from "./subagent-announce-delivery.js";

const log = createSubsystemLogger("agents/media-completion");
const queue = createMediaCompletionQueue({
  isActive(sessionKey) {
    const sessionId =
      resolveActiveEmbeddedRunSessionId(sessionKey) ??
      loadRequesterSessionEntry(sessionKey).entry?.sessionId;
    return Boolean(sessionId && isEmbeddedAgentRunActive(sessionId));
  },
  isDelivered: (entry) => getTaskById(entry.taskId)?.deliveryStatus === "delivered",
  setStatus: (entry, deliveryStatus) => {
    setDetachedTaskDeliveryStatusByRunId({
      runId: entry.runId,
      runtime: "cli",
      sessionKey: entry.sessionKey,
      deliveryStatus,
    });
  },
  async deliver(entry) {
    const triggerMessage = formatAgentInternalEventsForPrompt([entry.event]);
    try {
      const result = await deliverSubagentAnnouncement({
        requesterSessionKey: entry.sessionKey,
        targetRequesterSessionKey: entry.sessionKey,
        announceId: entry.idempotencyKey,
        directIdempotencyKey: entry.idempotencyKey,
        triggerMessage,
        steerMessage: triggerMessage,
        internalEvents: [entry.event],
        requesterSessionOrigin: entry.requesterOrigin,
        requesterOrigin: entry.requesterOrigin,
        completionDirectOrigin: entry.requesterOrigin,
        directOrigin: entry.requesterOrigin,
        sourceSessionKey: entry.event.childSessionKey,
        sourceChannel: INTERNAL_MESSAGE_CHANNEL,
        sourceTool: entry.toolName,
        requesterIsSubagent: false,
        expectsCompletionMessage: true,
        completionDelivery: "session-input",
        bestEffortDeliver: true,
      });
      if (result.delivered) {
        return { status: "accepted" };
      }
      if (result.sessionInputStatus === "deferred") {
        return { status: "deferred", error: result.error };
      }
      return { status: "failed", error: result.error ?? "Completion input was not accepted" };
    } catch (error) {
      return { status: "failed", error: formatErrorMessage(error) };
    }
  },
});
let timer: ReturnType<typeof setInterval> | undefined;

function drain(): void {
  void queue.drain().catch((error) => log.error("Media completion queue drain failed", { error }));
}

/** Recover persisted work on startup and retry when foreground sessions become idle. */
export function startMediaCompletionDelivery(): () => void {
  if (!timer) {
    timer = setInterval(drain, 5_000);
    timer.unref?.();
    drain();
  }
  return () => {
    if (timer) {
      clearInterval(timer);
    }
    timer = undefined;
  };
}

/** Persist before waking; provider generation is never part of delivery replay. */
export async function enqueueMediaCompletion(entry: MediaCompletionDelivery): Promise<void> {
  await queue.enqueue(entry);
  startMediaCompletionDelivery();
  drain();
}
