import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emitSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { acceptMediaCompletionInput } from "./media-completion-receipt.js";

const request = {
  sessionKey: "agent:main:main",
  sourceSessionKey: "image_generate:task-123",
  triggerMessage: "completion fixture",
  timeoutMs: 120_000,
};
const message = {
  role: "user",
  content: [{ type: "text", text: "Image ready" }],
  provenance: { kind: "inter_session", sourceSessionKey: request.sourceSessionKey },
};
function commit(value: unknown = message, sessionKey = request.sessionKey): void {
  emitSessionTranscriptUpdate({
    sessionFile: "/tmp/media-session.jsonl",
    sessionKey,
    message: value,
  });
}
afterEach(() => vi.useRealTimers());

describe("media completion session acceptance", () => {
  it("returns a committed receipt even when the request acknowledgement is lost", async () => {
    const dispatch = () => {
      commit();
      return new Promise<unknown>(() => {});
    };
    expect(await acceptMediaCompletionInput({ ...request, dispatch })).toEqual({
      status: "accepted",
    });
  });
  it("accepts committed input while the agent run is still unfinished", async () => {
    const dispatch = vi.fn(async () => {
      commit();
      return { status: "accepted", runId: "still-running" };
    });
    expect(await acceptMediaCompletionInput({ ...request, dispatch })).toEqual({
      status: "accepted",
    });
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("does not mistake a Gateway admission acknowledgement for session delivery", async () => {
    vi.useFakeTimers();
    const pending = acceptMediaCompletionInput({
      ...request,
      dispatch: async () => ({ status: "accepted" }),
    });
    await vi.advanceTimersByTimeAsync(120_001);
    expect(await pending).toMatchObject({ status: "deferred" });
  });

  it("ignores other tasks, sessions, assistant output and copied user text", async () => {
    vi.useFakeTimers();
    const pending = acceptMediaCompletionInput({
      ...request,
      dispatch: async () => ({ status: "accepted" }),
    });
    commit(message, "agent:other:main");
    commit({ ...message, role: "assistant" });
    commit({ ...message, provenance: { kind: "external_user" } });
    commit({
      ...message,
      provenance: { kind: "inter_session", sourceSessionKey: "image_generate:other" },
    });
    await vi.advanceTimersByTimeAsync(120_001);
    expect(await pending).toMatchObject({ status: "deferred" });
  });

  it("recognizes the exact steered completion input without inheriting foreground provenance", async () => {
    const dispatch = async () => {
      commit({ role: "user", content: request.triggerMessage });
      return { status: "accepted" };
    };
    expect(await acceptMediaCompletionInput({ ...request, dispatch })).toEqual({
      status: "accepted",
    });
  });

  it("reconciles a lost response against the persisted input before retrying", async () => {
    await withTempDir({ prefix: "media-receipt-" }, async (root) => {
      const sessionFile = path.join(root, "session.jsonl");
      await fs.writeFile(
        sessionFile,
        JSON.stringify({ type: "message", id: "receipt", message }) + "\n",
      );
      const dispatch = vi.fn();
      expect(await acceptMediaCompletionInput({ ...request, sessionFile, dispatch })).toEqual({
        status: "accepted",
      });
      expect(dispatch).not.toHaveBeenCalled();
    });
  });

  it("recognizes exact steering that inherited another internal run's provenance", async () => {
    await withTempDir({ prefix: "media-receipt-" }, async (root) => {
      const sessionFile = path.join(root, "session.jsonl");
      await fs.writeFile(
        sessionFile,
        JSON.stringify({
          type: "message",
          id: "steer",
          message: {
            role: "user",
            content: request.triggerMessage,
            provenance: { kind: "inter_session", sourceSessionKey: "agent:main:cron:foreground" },
          },
        }) + "\n",
      );
      const dispatch = vi.fn(async () => {
        throw new Error("must not dispatch twice");
      });
      expect(await acceptMediaCompletionInput({ ...request, sessionFile, dispatch })).toEqual({
        status: "accepted",
      });
      expect(dispatch).not.toHaveBeenCalled();
    });
  });

  it("does not dispatch after observing a receipt during the initial disk scan", async () => {
    const dispatch = vi.fn(async () => ({ status: "accepted" }));
    const pending = acceptMediaCompletionInput({ ...request, dispatch });
    commit();
    expect(await pending).toEqual({ status: "accepted" });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("keeps a committed receipt when the Gateway request subsequently throws", async () => {
    const dispatch = async () => {
      commit();
      throw new Error("gateway request timeout for agent");
    };
    expect(await acceptMediaCompletionInput({ ...request, dispatch })).toEqual({
      status: "accepted",
    });
  });

  it("reports a real admission failure separately from successful generation", async () => {
    const dispatch = async () => {
      throw new Error("session file locked");
    };
    expect(await acceptMediaCompletionInput({ ...request, dispatch })).toMatchObject({
      status: "failed",
      error: "session file locked",
    });
  });
});
