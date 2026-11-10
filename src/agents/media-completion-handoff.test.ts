import { afterEach, describe, expect, it, vi } from "vitest";
import { emitSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import type { EmbeddedAgentQueueMessageOutcome } from "./embedded-agent-runner/runs.js";
import { deliverSubagentAnnouncement, testing } from "./subagent-announce-delivery.js";
import type { dispatchGatewayMethodInProcess } from "./subagent-announce-delivery.runtime.js";

const params = {
  requesterSessionKey: "agent:main:media-test",
  targetRequesterSessionKey: "agent:main:media-test",
  sourceSessionKey: "image_generate:handoff-task",
  sourceTool: "image_generate",
  triggerMessage: "image completion",
  steerMessage: "image completion",
  completionDirectOrigin: { channel: "webchat" },
  requesterOrigin: { channel: "webchat" },
  requesterSessionOrigin: { channel: "webchat" },
  directOrigin: { channel: "webchat" },
  requesterIsSubagent: false,
  expectsCompletionMessage: true,
  directIdempotencyKey: "image_generate:handoff-task:ok",
  completionDelivery: "session-input" as const,
};
afterEach(() => {
  testing.setDepsForTest();
  vi.useRealTimers();
});

describe("native media handoff", () => {
  it("accepts committed Webchat steering without dispatching a second agent run", async () => {
    const dispatch = vi.fn();
    const queue = vi.fn(async () => ({
      queued: true as const,
      sessionId: "active",
      target: "embedded_run" as const,
      gatewayHealth: "live" as const,
      deliveredAtMs: Date.now(),
    }));
    testing.setDepsForTest({
      getRuntimeConfig: () => ({}),
      getRequesterSessionActivity: () => ({ sessionId: "active", isActive: true }),
      dispatchGatewayMethodInProcess: dispatch as typeof dispatchGatewayMethodInProcess,
      queueEmbeddedAgentMessageWithOutcome: queue,
    });
    expect(await deliverSubagentAnnouncement(params)).toMatchObject({ delivered: true });
    expect(queue).toHaveBeenCalledWith(
      "active",
      params.triggerMessage,
      expect.objectContaining({
        waitForTranscriptCommit: true,
        sourceReplyDeliveryMode: "automatic",
      }),
    );
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("acknowledges idle session input without waiting for the agent final", async () => {
    const dispatch = vi.fn(async () => {
      emitSessionTranscriptUpdate({
        sessionFile: "/tmp/handoff.jsonl",
        sessionKey: params.requesterSessionKey,
        message: {
          role: "user",
          provenance: { kind: "inter_session", sourceSessionKey: params.sourceSessionKey },
        },
      });
      return { status: "accepted", runId: "unfinished" };
    });
    testing.setDepsForTest({
      getRuntimeConfig: () => ({}),
      getRequesterSessionActivity: () => ({ isActive: false }),
      dispatchGatewayMethodInProcess: dispatch as typeof dispatchGatewayMethodInProcess,
    });
    expect(await deliverSubagentAnnouncement(params)).toMatchObject({ delivered: true });
    expect(dispatch).toHaveBeenCalledWith(
      "agent",
      expect.objectContaining({ idempotencyKey: params.directIdempotencyKey }),
      expect.objectContaining({ expectFinal: false }),
    );
  });

  it("defers rejected active steering without starting an overlapping Gateway handoff", async () => {
    const dispatch = vi.fn();
    testing.setDepsForTest({
      getRuntimeConfig: () => ({}),
      getRequesterSessionActivity: () => ({ sessionId: "active", isActive: true }),
      dispatchGatewayMethodInProcess: dispatch as typeof dispatchGatewayMethodInProcess,
      queueEmbeddedAgentMessageWithOutcome: async () => ({
        queued: false,
        sessionId: "active",
        reason: "not_streaming",
        gatewayHealth: "live",
      }),
    });
    expect(await deliverSubagentAnnouncement(params)).toMatchObject({
      delivered: false,
      sessionInputStatus: "deferred",
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it.each(["unsupported_commit_wait", "reply_run"] as const)(
    "does not acknowledge an uncommitted %s queue entry",
    async (kind) => {
      vi.useFakeTimers();
      const dispatch = vi.fn();
      let attempt = 0;
      const queue = vi.fn(async (): Promise<EmbeddedAgentQueueMessageOutcome> => {
        if (kind === "unsupported_commit_wait" && attempt++ === 0) {
          return {
            queued: false,
            sessionId: "active",
            gatewayHealth: "live",
            reason: "transcript_commit_wait_unsupported",
          };
        }
        return {
          queued: true,
          sessionId: "active",
          gatewayHealth: "live",
          target: kind === "reply_run" ? "reply_run" : "embedded_run",
          enqueuedAtMs: Date.now(),
        };
      });
      testing.setDepsForTest({
        getRuntimeConfig: () => ({
          agents: { defaults: { subagents: { announceTimeoutMs: 50 } } },
        }),
        getRequesterSessionActivity: () => ({ sessionId: "active", isActive: true }),
        dispatchGatewayMethodInProcess: dispatch as typeof dispatchGatewayMethodInProcess,
        queueEmbeddedAgentMessageWithOutcome: queue,
      });
      const result = deliverSubagentAnnouncement(params);
      await vi.advanceTimersByTimeAsync(51);
      expect(await result).toMatchObject({ delivered: false, sessionInputStatus: "deferred" });
      expect(dispatch).not.toHaveBeenCalled();
    },
  );

  it("hands inactive cron media to its session without sending the fallback attachment", async () => {
    const sessionKey = "agent:main:cron:media-probe:run:completed-run";
    const origin = { channel: "slack", to: "channel:media-probe", accountId: "probe" };
    const sendMessage = vi.fn();
    const dispatch = vi.fn(async () => {
      emitSessionTranscriptUpdate({
        sessionFile: "/tmp/cron-handoff.jsonl",
        sessionKey,
        message: {
          role: "user",
          provenance: { kind: "inter_session", sourceSessionKey: params.sourceSessionKey },
        },
      });
      return { status: "accepted", runId: "unfinished" };
    });
    testing.setDepsForTest({
      getRuntimeConfig: () => ({}),
      getRequesterSessionActivity: () => ({ isActive: false }),
      dispatchGatewayMethodInProcess: dispatch as typeof dispatchGatewayMethodInProcess,
      sendMessage,
    });
    const result = await deliverSubagentAnnouncement({
      ...params,
      requesterSessionKey: sessionKey,
      targetRequesterSessionKey: sessionKey,
      requesterOrigin: origin,
      requesterSessionOrigin: origin,
      completionDirectOrigin: origin,
      directOrigin: origin,
      internalEvents: [
        {
          type: "task_completion",
          source: "image_generation",
          childSessionKey: params.sourceSessionKey,
          childSessionId: "handoff-task",
          announceType: "image generation task",
          taskLabel: "cron image",
          status: "ok",
          statusLabel: "completed successfully",
          result: "image ready",
          mediaUrls: ["/tmp/generated-cron-image.png"],
          replyInstruction: "Send the original generated image.",
        },
      ],
    });
    expect(result).toMatchObject({ delivered: true, sessionInputStatus: "accepted" });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
