import {
  moveSessionDeliveryToFailed,
  type MediaCompletionDelivery,
} from "../infra/session-delivery-queue-storage.js";
import {
  ackSessionDelivery,
  enqueueSessionDelivery,
  failSessionDelivery,
  isSessionDeliveryEligibleForRetry,
  loadPendingSessionDeliveries,
} from "../infra/session-delivery-queue.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { MediaCompletionAcceptance } from "./media-completion-receipt.js";

const log = createSubsystemLogger("agents/media-completion");
const MAX_ATTEMPTS = 5;

/** Own the durable handoff independently of the generation task's terminal state. */
export function createMediaCompletionQueue(deps: {
  stateDir?: string;
  deliver: (entry: MediaCompletionDelivery) => Promise<MediaCompletionAcceptance>;
  isActive: (sessionKey: string) => boolean;
  isDelivered: (entry: MediaCompletionDelivery) => boolean;
  setStatus: (entry: MediaCompletionDelivery, status: "pending" | "delivered" | "failed") => void;
}) {
  let draining: Promise<void> | undefined;
  const waitingForIdle = new Set<string>();

  async function drainPending(): Promise<void> {
    const entries = (await loadPendingSessionDeliveries(deps.stateDir))
      .filter((entry) => entry.kind === "mediaCompletion")
      .toSorted((a, b) => a.enqueuedAt - b.enqueuedAt);
    for (const entry of entries) {
      if (deps.isDelivered(entry)) {
        waitingForIdle.delete(entry.id);
        await ackSessionDelivery(entry.id, deps.stateDir);
        continue;
      }
      if (waitingForIdle.has(entry.id) && deps.isActive(entry.sessionKey)) {
        continue;
      }
      waitingForIdle.delete(entry.id);
      if (!isSessionDeliveryEligibleForRetry(entry, Date.now()).eligible) {
        continue;
      }
      if (entry.retryCount >= MAX_ATTEMPTS) {
        deps.setStatus(entry, "failed");
        await moveSessionDeliveryToFailed(entry.id, deps.stateDir);
        log.error("Media completion delivery exhausted; generated media remains successful", {
          taskId: entry.taskId,
        });
        continue;
      }
      const result = await deps.deliver(entry);
      if (result.status === "accepted") {
        // Persist status before deleting the queue file. Recovery can finish an
        // interrupted acknowledgement without asking the agent to repeat work.
        deps.setStatus(entry, "delivered");
        await ackSessionDelivery(entry.id, deps.stateDir);
        log.info("Media completion input accepted by requester session", {
          taskId: entry.taskId,
          runId: entry.runId,
        });
      } else if (deps.isActive(entry.sessionKey)) {
        waitingForIdle.add(entry.id);
        log.info("Media completion delivery deferred until requester is idle", {
          taskId: entry.taskId,
        });
      } else {
        await failSessionDelivery(
          entry.id,
          result.error ?? "Completion input was not committed",
          deps.stateDir,
        );
        log.warn("Media completion delivery will retry original result", {
          taskId: entry.taskId,
          attempt: entry.retryCount + 1,
          error: result.error,
        });
      }
    }
  }

  return {
    async enqueue(entry: MediaCompletionDelivery): Promise<void> {
      if (deps.isDelivered(entry)) {
        return;
      }
      await enqueueSessionDelivery({ ...entry, maxRetries: MAX_ATTEMPTS }, deps.stateDir);
      deps.setStatus(entry, "pending");
    },
    drain(): Promise<void> {
      draining ??= drainPending().finally(() => {
        draining = undefined;
      });
      return draining;
    },
  };
}
