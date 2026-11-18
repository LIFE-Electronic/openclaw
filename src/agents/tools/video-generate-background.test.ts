import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAgentRunContext, resetAgentRunContextForTest } from "../../infra/agent-events.js";
import { VIDEO_GENERATION_TASK_KIND } from "../video-generation-task-status.js";
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
  createVideoGenerationTaskRun,
  failVideoGenerationTaskRun,
  recordVideoGenerationTaskProgress,
  wakeVideoGenerationTaskCompletion,
} = await import("./video-generate-background.js");
const { withMediaGenerationTaskKeepalive } = await import("./media-generate-background-shared.js");

describe("video generate background helpers", () => {
  beforeEach(() => {
    resetAgentRunContextForTest();
    resetMediaBackgroundMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetAgentRunContextForTest();
  });

  it("creates a running task with queued progress text", () => {
    taskExecutorMocks.createRunningTaskRun.mockReturnValue({
      taskId: "task-123",
    });

    const handle = createVideoGenerationTaskRun({
      sessionKey: "agent:main:discord:direct:123",
      requesterOrigin: {
        channel: "discord",
        to: "channel:1",
      },
      prompt: "friendly lobster surfing",
      providerId: "openai",
    });

    expect(handle?.taskId).toBe("task-123");
    expect(handle?.requesterSessionKey).toBe("agent:main:discord:direct:123");
    expect(handle?.taskLabel).toBe("friendly lobster surfing");
    expectQueuedTaskRun({
      taskKind: VIDEO_GENERATION_TASK_KIND,
      sourceId: "video_generate:openai",
      progressSummary: "Queued video generation",
    });
  });

  it("records task progress updates", () => {
    recordVideoGenerationTaskProgress({
      handle: {
        taskId: "task-123",
        runId: "tool:video_generate:abc",
        requesterSessionKey: "agent:main:discord:direct:123",
        taskLabel: "friendly lobster surfing",
      },
      progressSummary: "Saving generated video",
    });

    expectRecordedTaskProgress({
      runId: "tool:video_generate:abc",
      progressSummary: "Saving generated video",
    });
  });

  it("keeps the detached video tool run context registered until terminal status", () => {
    taskExecutorMocks.createRunningTaskRun.mockReturnValue({
      taskId: "task-123",
    });

    const handle = createVideoGenerationTaskRun({
      sessionKey: "agent:main:discord:channel:123",
      prompt: "friendly lobster surfing",
      providerId: "fal",
    });
    if (!handle) {
      throw new Error("expected video generation task handle");
    }

    expect(handle.runId).toMatch(/^tool:video_generate:/);
    expect(getAgentRunContext(handle.runId)?.sessionKey).toBe("agent:main:discord:channel:123");

    const beforeProgress = Date.now();
    recordVideoGenerationTaskProgress({
      handle,
      progressSummary: "Generating video",
    });

    expect(getAgentRunContext(handle.runId)?.lastActiveAt).toBeGreaterThanOrEqual(beforeProgress);

    failVideoGenerationTaskRun({
      handle,
      error: new Error("provider failed"),
    });

    expect(getAgentRunContext(handle.runId)).toBeUndefined();
  });

  it("keeps long-running media tasks fresh while provider work is pending", async () => {
    vi.useFakeTimers();
    let resolveRun: ((value: string) => void) | undefined;
    const runPromise = new Promise<string>((resolve) => {
      resolveRun = resolve;
    });
    const task = withMediaGenerationTaskKeepalive({
      handle: {
        taskId: "task-123",
        runId: "tool:video_generate:abc",
        requesterSessionKey: "agent:main:discord:direct:123",
        taskLabel: "friendly lobster surfing",
      },
      progressSummary: "Generating video",
      run: () => runPromise,
    });

    await vi.advanceTimersByTimeAsync(60_000);

    expectRecordedTaskProgress({
      runId: "tool:video_generate:abc",
      progressSummary: "Generating video",
    });

    if (!resolveRun) {
      throw new Error("Expected video generation run resolver to be initialized");
    }
    resolveRun("done");
    await expect(task).resolves.toBe("done");
    const callsAfterCompletion = taskExecutorMocks.recordTaskRunProgressByRunId.mock.calls.length;

    await vi.advanceTimersByTimeAsync(60_000);

    expect(taskExecutorMocks.recordTaskRunProgressByRunId).toHaveBeenCalledTimes(
      callsAfterCompletion,
    );
  });

  testMediaCompletionQueue(
    "video",
    wakeVideoGenerationTaskCompletion,
    "/tmp/generated-lobster.mp4",
  );
});
