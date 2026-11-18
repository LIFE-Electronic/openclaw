import { expect, it, vi } from "vitest";
import type { MediaCompletionDelivery } from "../../infra/session-delivery-queue-storage.js";
import type { createMediaGenerationTaskLifecycle } from "./media-generate-background-shared.js";

export const taskExecutorMocks = {
  createRunningTaskRun: vi.fn(),
  recordTaskRunProgressByRunId: vi.fn(),
  completeTaskRunByRunId: vi.fn(),
  failTaskRunByRunId: vi.fn(),
  setDetachedTaskDeliveryStatusByRunId: vi.fn(),
};
export const mediaCompletionMocks = {
  enqueueMediaCompletion: vi.fn<(entry: MediaCompletionDelivery) => Promise<void>>(),
};
export const taskDeliveryRuntimeMocks = { sendMessage: vi.fn() };

export function resetMediaBackgroundMocks(): void {
  for (const mock of Object.values(taskExecutorMocks)) {
    mock.mockReset();
  }
  mediaCompletionMocks.enqueueMediaCompletion.mockReset().mockResolvedValue(undefined);
  taskDeliveryRuntimeMocks.sendMessage.mockReset();
}

export function expectQueuedTaskRun(expected: {
  taskKind: string;
  sourceId: string;
  progressSummary: string;
}): void {
  expect(taskExecutorMocks.createRunningTaskRun).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining(expected),
  );
}

export function expectRecordedTaskProgress(expected: {
  runId: string;
  progressSummary: string;
}): void {
  expect(taskExecutorMocks.recordTaskRunProgressByRunId).toHaveBeenCalledWith(
    expect.objectContaining(expected),
  );
}

type WakeCompletion = ReturnType<typeof createMediaGenerationTaskLifecycle>["wakeTaskCompletion"];

/** Exercise each public tool wrapper at the boundary that persists the original session event. */
export function testMediaCompletionQueue(
  kind: "image" | "music" | "video",
  wake: WakeCompletion,
  mediaPath: string,
) {
  const toolName = `${kind}_generate`;
  const handle = {
    taskId: "task-123",
    runId: `tool:${toolName}:abc`,
    requesterSessionKey: "agent:main:discord:direct:123",
    requesterOrigin: { channel: "discord", to: "channel:1", threadId: "thread-1" },
    taskLabel: `generate ${kind} for this thread`,
  };

  it.each([
    { status: "ok", directSend: false },
    { status: "ok", directSend: true },
    { status: "error", directSend: false },
    { status: "error", directSend: true },
  ] as const)(
    "queues the original $status notice with directSend=$directSend",
    async ({ status, directSend }) => {
      const success = status === "ok";
      const result = success
        ? `Generated ${kind}.\nMEDIA:${mediaPath}`
        : `${kind} provider unavailable`;
      const statusLabel = success ? "completed successfully" : "failed";
      await expect(
        wake({
          // Omit the setting in the default case, as existing configs do.
          ...(directSend
            ? { config: { tools: { media: { asyncCompletion: { directSend } } } } }
            : {}),
          handle,
          status,
          statusLabel,
          result,
          ...(success ? { mediaUrls: [mediaPath] } : {}),
        }),
      ).resolves.toBe(true);

      expect(mediaCompletionMocks.enqueueMediaCompletion).toHaveBeenCalledExactlyOnceWith({
        kind: "mediaCompletion",
        toolName,
        taskId: handle.taskId,
        runId: handle.runId,
        idempotencyKey: `${toolName}:${handle.taskId}:${status}`,
        sessionKey: handle.requesterSessionKey,
        requesterOrigin: handle.requesterOrigin,
        event: {
          type: "task_completion",
          source: `${kind}_generation`,
          announceType: `${kind} generation task`,
          childSessionId: handle.taskId,
          childSessionKey: `${toolName}:${handle.taskId}`,
          taskLabel: handle.taskLabel,
          status,
          statusLabel,
          result,
          ...(success ? { mediaUrls: [mediaPath] } : {}),
          replyInstruction: expect.stringContaining(
            success
              ? "the media must be sent as message-tool attachments"
              : "put the failure summary in the message",
          ),
        },
      });
      expect(taskDeliveryRuntimeMocks.sendMessage).not.toHaveBeenCalled();
    },
  );
}
