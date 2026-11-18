import { afterEach, describe, expect, it, vi } from "vitest";
import type { MediaCompletionDelivery } from "../infra/session-delivery-queue-storage.js";
import {
  enqueueSessionDelivery,
  loadPendingSessionDeliveries,
} from "../infra/session-delivery-queue.js";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { createMediaCompletionQueue } from "./media-completion-queue.js";
import type { MediaCompletionAcceptance } from "./media-completion-receipt.js";

const completion = {
  kind: "mediaCompletion" as const,
  sessionKey: "agent:main:main",
  taskId: "task-123",
  runId: "tool:image_generate:123",
  toolName: "image_generate",
  idempotencyKey: "image_generate:task-123:ok",
  requesterOrigin: { channel: "webchat" },
  event: {
    type: "task_completion" as const,
    source: "image_generation" as const,
    childSessionKey: "image_generate:task-123",
    childSessionId: "task-123",
    announceType: "image generation task",
    taskLabel: "fixture",
    status: "ok" as const,
    statusLabel: "completed successfully",
    result: "ready",
    attachments: [{ path: "/home/node/.openclaw/media/image.png", mimeType: "image/png" }],
    replyInstruction: "Send the image in Webchat",
  },
};
afterEach(() => vi.restoreAllMocks());

describe("durable media completion queue", () => {
  it("persists one original event, survives a new worker, and acknowledges only session acceptance", async () => {
    await withTempDir({ prefix: "media-completion-" }, async (stateDir) => {
      const setStatus = vi.fn();
      const deliver = vi.fn(
        async (_entry: MediaCompletionDelivery): Promise<MediaCompletionAcceptance> => ({
          status: "accepted",
        }),
      );
      const deps = {
        stateDir,
        deliver,
        isActive: () => false,
        isDelivered: () => false,
        setStatus,
      };
      const first = createMediaCompletionQueue(deps);
      await first.enqueue(completion);
      await first.enqueue(completion);
      expect(await loadPendingSessionDeliveries(stateDir)).toHaveLength(1);
      expect(deliver).not.toHaveBeenCalled();
      await createMediaCompletionQueue(deps).drain();
      expect(deliver).toHaveBeenCalledOnce();
      expect(deliver.mock.calls[0]?.[0]).toMatchObject(completion);
      expect(setStatus).toHaveBeenLastCalledWith(expect.objectContaining(completion), "delivered");
      expect(await loadPendingSessionDeliveries(stateDir)).toEqual([]);
    });
  });

  it("defers busy sessions without exhausting attempts or resending pending input", async () => {
    await withTempDir({ prefix: "media-completion-" }, async (stateDir) => {
      let active = true;
      const deliver = vi.fn(
        async (): Promise<MediaCompletionAcceptance> => ({
          status: active ? "deferred" : "accepted",
        }),
      );
      const queue = createMediaCompletionQueue({
        stateDir,
        deliver,
        isActive: () => active,
        isDelivered: () => false,
        setStatus: vi.fn(),
      });
      await queue.enqueue(completion);
      for (let i = 0; i < 10; i++) {
        await queue.drain();
      }
      expect(deliver).toHaveBeenCalledOnce();
      expect((await loadPendingSessionDeliveries(stateDir))[0]?.retryCount).toBe(0);
      active = false;
      await queue.drain();
      expect(deliver).toHaveBeenCalledTimes(2);
      expect(await loadPendingSessionDeliveries(stateDir)).toEqual([]);
    });
  });

  it("retains exhausted notification failures without changing generation state", async () => {
    await withTempDir({ prefix: "media-completion-" }, async (stateDir) => {
      let now = Date.now();
      vi.spyOn(Date, "now").mockImplementation(() => now);
      const deliver = vi.fn(
        async (): Promise<MediaCompletionAcceptance> => ({
          status: "failed",
          error: "gateway unavailable",
        }),
      );
      const setStatus = vi.fn();
      const queue = createMediaCompletionQueue({
        stateDir,
        deliver,
        isActive: () => false,
        isDelivered: () => false,
        setStatus,
      });
      await queue.enqueue(completion);
      for (let i = 0; i < 8; i++) {
        await queue.drain();
        now += 3_600_000;
      }
      expect(deliver).toHaveBeenCalledTimes(5);
      expect(setStatus).toHaveBeenLastCalledWith(expect.objectContaining(completion), "failed");
      expect(await loadPendingSessionDeliveries(stateDir)).toEqual([]);
    });
  });

  it("counts an uncommitted handoff to an idle session as a retryable delivery failure", async () => {
    await withTempDir({ prefix: "media-completion-" }, async (stateDir) => {
      const queue = createMediaCompletionQueue({
        stateDir,
        deliver: async () => ({ status: "deferred" }),
        isActive: () => false,
        isDelivered: () => false,
        setStatus: vi.fn(),
      });
      await queue.enqueue(completion);
      await queue.drain();
      expect((await loadPendingSessionDeliveries(stateDir))[0]?.retryCount).toBe(1);
    });
  });

  it("coalesces overlapping drains and leaves unrelated restart events alone", async () => {
    await withTempDir({ prefix: "media-completion-" }, async (stateDir) => {
      const deliver = vi.fn(
        async (): Promise<MediaCompletionAcceptance> => ({ status: "accepted" }),
      );
      const queue = createMediaCompletionQueue({
        stateDir,
        deliver,
        isActive: () => false,
        isDelivered: () => false,
        setStatus: vi.fn(),
      });
      await queue.enqueue(completion);
      await enqueueSessionDelivery(
        { kind: "systemEvent", sessionKey: completion.sessionKey, text: "restart" },
        stateDir,
      );
      await Promise.all([queue.drain(), queue.drain()]);
      expect(deliver).toHaveBeenCalledOnce();
      expect((await loadPendingSessionDeliveries(stateDir)).map((entry) => entry.kind)).toEqual([
        "systemEvent",
      ]);
    });
  });

  it("finishes an interrupted acknowledgement without invoking the agent again", async () => {
    await withTempDir({ prefix: "media-completion-" }, async (stateDir) => {
      await enqueueSessionDelivery(completion, stateDir);
      const deliver = vi.fn();
      const queue = createMediaCompletionQueue({
        stateDir,
        deliver,
        isActive: () => false,
        isDelivered: () => true,
        setStatus: vi.fn(),
      });
      await queue.drain();
      await queue.enqueue(completion);
      expect(deliver).not.toHaveBeenCalled();
      expect(await loadPendingSessionDeliveries(stateDir)).toEqual([]);
    });
  });
});
