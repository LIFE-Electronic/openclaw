import { beforeEach, describe, expect, it, vi } from "vitest";
import { MUSIC_GENERATION_TASK_KIND } from "../music-generation-task-status.js";
import {
  mediaCompletionMocks,
  testMediaCompletionQueue,
  expectQueuedTaskRun,
  expectRecordedTaskProgress,
  resetMediaBackgroundMocks,
  taskDeliveryRuntimeMocks,
  taskExecutorMocks,
} from "./media-generate-background.test-support.js";

vi.mock("../../tasks/detached-task-runtime.js", () => taskExecutorMocks);
vi.mock("../../tasks/task-registry-delivery-runtime.js", () => taskDeliveryRuntimeMocks);
vi.mock("../media-completion-runtime.js", () => mediaCompletionMocks);

const {
  createMusicGenerationTaskRun,
  recordMusicGenerationTaskProgress,
  wakeMusicGenerationTaskCompletion,
} = await import("./music-generate-background.js");

describe("music generate background helpers", () => {
  beforeEach(resetMediaBackgroundMocks);

  it("creates a running task with queued progress text", () => {
    taskExecutorMocks.createRunningTaskRun.mockReturnValue({
      taskId: "task-123",
    });

    const handle = createMusicGenerationTaskRun({
      sessionKey: "agent:main:discord:direct:123",
      requesterOrigin: {
        channel: "discord",
        to: "channel:1",
      },
      prompt: "night-drive synthwave",
      providerId: "google",
    });

    if (!handle) {
      throw new Error("Expected music generation task handle");
    }
    expect(handle.taskId).toBe("task-123");
    expect(handle.requesterSessionKey).toBe("agent:main:discord:direct:123");
    expect(handle.taskLabel).toBe("night-drive synthwave");
    expectQueuedTaskRun({
      taskKind: MUSIC_GENERATION_TASK_KIND,
      sourceId: "music_generate:google",
      progressSummary: "Queued music generation",
    });
  });

  it("records task progress updates", () => {
    recordMusicGenerationTaskProgress({
      handle: {
        taskId: "task-123",
        runId: "tool:music_generate:abc",
        requesterSessionKey: "agent:main:discord:direct:123",
        taskLabel: "night-drive synthwave",
      },
      progressSummary: "Saving generated music",
    });

    expectRecordedTaskProgress({
      runId: "tool:music_generate:abc",
      progressSummary: "Saving generated music",
    });
  });

  testMediaCompletionQueue(
    "music",
    wakeMusicGenerationTaskCompletion,
    "/tmp/generated-night-drive.mp3",
  );

  it.each([
    ["agent:main:discord:channel:C123", "discord", "C123"],
    ["agent:main:discord:guild-123:channel-456", "discord", "channel-456"],
    ["agent:main:whatsapp:123@g.us", "whatsapp", "123@g.us"],
  ])("retains the saved channel route for %s", async (requesterSessionKey, channel, to) => {
    const requesterOrigin = { channel, to };
    await wakeMusicGenerationTaskCompletion({
      handle: {
        taskId: "task-123",
        runId: "tool:music_generate:abc",
        taskLabel: "night-drive synthwave",
        requesterSessionKey,
        requesterOrigin,
      },
      status: "ok",
      statusLabel: "completed successfully",
      result: "Generated 1 track.",
      mediaUrls: ["/tmp/generated-night-drive.mp3"],
    });
    expect(mediaCompletionMocks.enqueueMediaCompletion).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        sessionKey: requesterSessionKey,
        requesterOrigin,
        event: expect.objectContaining({
          replyInstruction: expect.stringContaining(
            "the user will NOT see your normal assistant final reply",
          ),
        }),
      }),
    );
    expect(taskDeliveryRuntimeMocks.sendMessage).not.toHaveBeenCalled();
  });
});
