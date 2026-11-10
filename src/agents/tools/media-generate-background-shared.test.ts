import { describe, expect, it, vi } from "vitest";

const subagentAnnounceDeliveryMocks = vi.hoisted(() => ({
  enqueueMediaCompletion: vi.fn(),
}));

vi.mock("../media-completion-runtime.js", () => subagentAnnounceDeliveryMocks);

import {
  createMediaGenerationTaskLifecycle,
  scheduleMediaGenerationTaskCompletion,
} from "./media-generate-background-shared.js";

describe("scheduleMediaGenerationTaskCompletion", () => {
  it.each(["Image", "Video", "Music"])(
    "still fails a real %s provider error exactly once",
    async (kind) => {
      const scheduled: Array<() => Promise<void>> = [];
      const error = new Error("provider rejected request");
      const lifecycle = {
        createTaskRun: vi.fn(),
        recordTaskProgress: vi.fn(),
        completeTaskRun: vi.fn(),
        failTaskRun: vi.fn(),
        wakeTaskCompletion: vi.fn(async () => true),
      };
      scheduleMediaGenerationTaskCompletion({
        lifecycle,
        handle: null,
        scheduleBackgroundWork: (work) => {
          scheduled.push(work);
        },
        progressSummary: "Generating media",
        toolName: `${kind} generation`,
        onWakeFailure: vi.fn(),
        run: async () => {
          throw error;
        },
      });
      await scheduled[0]?.();
      expect(lifecycle.completeTaskRun).not.toHaveBeenCalled();
      expect(lifecycle.failTaskRun).toHaveBeenCalledExactlyOnceWith({ handle: null, error });
      expect(lifecycle.wakeTaskCompletion).toHaveBeenCalledOnce();
      expect(lifecycle.wakeTaskCompletion).toHaveBeenCalledWith(
        expect.objectContaining({ status: "error", result: error.message }),
      );
    },
  );
  it("completes generation before attempting completion delivery", async () => {
    const order: string[] = [];
    const scheduled: Array<() => Promise<void>> = [];
    const completeTaskRun = vi.fn(() => {
      order.push("complete");
    });
    const lifecycle = {
      createTaskRun: vi.fn(),
      recordTaskProgress: vi.fn(() => {
        order.push("progress");
      }),
      completeTaskRun,
      failTaskRun: vi.fn(),
      wakeTaskCompletion: vi.fn(async () => {
        order.push("wake");
        expect(completeTaskRun).toHaveBeenCalledOnce();
        return true;
      }),
    };

    scheduleMediaGenerationTaskCompletion({
      lifecycle,
      handle: {
        taskId: "task-image-123",
        runId: "tool:image_generate:123",
        requesterSessionKey: "agent:main:discord:channel:123",
        taskLabel: "proof image",
      },
      scheduleBackgroundWork: (work) => {
        scheduled.push(work);
      },
      progressSummary: "Generating image",
      toolName: "Image generation",
      onWakeFailure: vi.fn(),
      run: async () => {
        order.push("run");
        return {
          provider: "openai",
          model: "gpt-image-1",
          count: 1,
          paths: ["/tmp/proof.png"],
          wakeResult: "generated",
        };
      },
    });

    expect(scheduled).toHaveLength(1);
    await scheduled[0]?.();

    expect(order).toEqual(["run", "complete", "wake"]);
    expect(lifecycle.completeTaskRun).toHaveBeenCalledWith(
      expect.objectContaining({
        count: 1,
        paths: ["/tmp/proof.png"],
      }),
    );
  });

  it("keeps generation successful when completion delivery cannot be confirmed", async () => {
    const scheduled: Array<() => Promise<void>> = [];
    const lifecycle = {
      createTaskRun: vi.fn(),
      recordTaskProgress: vi.fn(),
      completeTaskRun: vi.fn(),
      failTaskRun: vi.fn(),
      wakeTaskCompletion: vi.fn(async () => false),
    };

    scheduleMediaGenerationTaskCompletion({
      lifecycle,
      handle: {
        taskId: "task-image-456",
        runId: "tool:image_generate:456",
        requesterSessionKey: "agent:main:discord:channel:123",
        taskLabel: "proof image",
      },
      scheduleBackgroundWork: (work) => {
        scheduled.push(work);
      },
      progressSummary: "Generating image",
      toolName: "Image generation",
      onWakeFailure: vi.fn(),
      run: async () => ({
        provider: "openai",
        model: "gpt-image-1",
        count: 1,
        paths: ["/tmp/proof.png"],
        wakeResult: "generated",
      }),
    });

    await scheduled[0]?.();

    expect(lifecycle.completeTaskRun).toHaveBeenCalledOnce();
    expect(lifecycle.failTaskRun).not.toHaveBeenCalled();
    expect(lifecycle.wakeTaskCompletion).toHaveBeenCalledOnce();
    expect(lifecycle.wakeTaskCompletion).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: "ok",
        result: "generated",
      }),
    );
  });

  it("logs a wake exception without announcing a generation failure", async () => {
    const scheduled: Array<() => Promise<void>> = [];
    const wakeError = new Error("requester wake failed");
    const lifecycle = {
      createTaskRun: vi.fn(),
      recordTaskProgress: vi.fn(),
      completeTaskRun: vi.fn(),
      failTaskRun: vi.fn(),
      wakeTaskCompletion: vi.fn().mockRejectedValueOnce(wakeError).mockResolvedValueOnce(true),
    };
    const onWakeFailure = vi.fn();

    scheduleMediaGenerationTaskCompletion({
      lifecycle,
      handle: {
        taskId: "task-image-789",
        runId: "tool:image_generate:789",
        requesterSessionKey: "agent:main:discord:channel:123",
        taskLabel: "proof image",
      },
      scheduleBackgroundWork: (work) => {
        scheduled.push(work);
      },
      progressSummary: "Generating image",
      toolName: "Image generation",
      onWakeFailure,
      run: async () => ({
        provider: "openai",
        model: "gpt-image-1",
        count: 1,
        paths: ["/tmp/proof.png"],
        wakeResult: "generated",
      }),
    });

    await scheduled[0]?.();

    expect(onWakeFailure).toHaveBeenCalledWith(
      "Image generation completion wake failed after successful generation",
      expect.objectContaining({
        error: wakeError,
        runId: "tool:image_generate:789",
        taskId: "task-image-789",
      }),
    );
    expect(lifecycle.completeTaskRun).toHaveBeenCalledOnce();
    expect(lifecycle.failTaskRun).not.toHaveBeenCalled();
    expect(lifecycle.wakeTaskCompletion).toHaveBeenCalledOnce();
    expect(lifecycle.wakeTaskCompletion).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: "ok",
        result: "generated",
      }),
    );
  });
});

describe("createMediaGenerationTaskLifecycle", () => {
  it("persists the original completion for delivery without waiting for an agent final", async () => {
    subagentAnnounceDeliveryMocks.enqueueMediaCompletion.mockResolvedValueOnce(undefined);
    const lifecycle = createMediaGenerationTaskLifecycle({
      toolName: "image_generate",
      taskKind: "image_generation",
      label: "Image generation",
      queuedProgressSummary: "Queued image generation",
      generatedLabel: "image",
      failureProgressSummary: "Image generation failed",
      eventSource: "image_generation",
      announceType: "image generation task",
      completionLabel: "image",
    });

    await expect(
      lifecycle.wakeTaskCompletion({
        handle: {
          taskId: "task-image-789",
          runId: "tool:image_generate:789",
          requesterSessionKey: "agent:main:discord:channel:123",
          taskLabel: "proof image",
          requesterOrigin: {
            channel: "discord",
            to: "channel:123",
          },
        },
        status: "ok",
        statusLabel: "completed successfully",
        result: "generated",
      }),
    ).resolves.toBe(true);
    expect(subagentAnnounceDeliveryMocks.enqueueMediaCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "task-image-789",
        runId: "tool:image_generate:789",
        idempotencyKey: "image_generate:task-image-789:ok",
        event: expect.objectContaining({ status: "ok", source: "image_generation" }),
      }),
    );
  });
});
