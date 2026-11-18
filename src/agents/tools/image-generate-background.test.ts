import { beforeEach, describe, expect, it, vi } from "vitest";
import { IMAGE_GENERATION_TASK_KIND } from "../image-generation-task-status.js";
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
  createImageGenerationTaskRun,
  recordImageGenerationTaskProgress,
  wakeImageGenerationTaskCompletion,
} = await import("./image-generate-background.js");

describe("image generate background helpers", () => {
  beforeEach(resetMediaBackgroundMocks);

  it("creates a running task with queued progress text", () => {
    taskExecutorMocks.createRunningTaskRun.mockReturnValue({
      taskId: "task-123",
    });

    const handle = createImageGenerationTaskRun({
      sessionKey: "agent:main:discord:direct:123",
      requesterOrigin: {
        channel: "discord",
        to: "channel:1",
      },
      prompt: "small watercolor robot",
      providerId: "openai",
    });

    if (!handle) {
      throw new Error("Expected image generation task handle");
    }
    expect(handle.taskId).toBe("task-123");
    expect(handle.requesterSessionKey).toBe("agent:main:discord:direct:123");
    expect(handle.taskLabel).toBe("small watercolor robot");
    expectQueuedTaskRun({
      taskKind: IMAGE_GENERATION_TASK_KIND,
      sourceId: "image_generate:openai",
      progressSummary: "Queued image generation",
    });
  });

  it("records task progress updates", () => {
    recordImageGenerationTaskProgress({
      handle: {
        taskId: "task-123",
        runId: "tool:image_generate:abc",
        requesterSessionKey: "agent:main:discord:direct:123",
        taskLabel: "small watercolor robot",
      },
      progressSummary: "Saving generated image",
    });

    expectRecordedTaskProgress({
      runId: "tool:image_generate:abc",
      progressSummary: "Saving generated image",
    });
  });

  testMediaCompletionQueue("image", wakeImageGenerationTaskCompletion, "/tmp/generated-robot.png");
});
