import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copyMessage, type CopyRequest, type CopyDependencies } from "./wolper-message-copy.js";

describe("durable native message copies", () => {
  let stateDir: string;
  let request: CopyRequest;
  let deps: CopyDependencies;
  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "wolper-copy-"));
    request = {
      copyId: randomUUID(),
      executionId: randomUUID(),
      destinationSessionKey: "agent:main:dashboard:imessage-test",
      origin: {
        trigger: "cron",
        is_heartbeat: false,
        cron_job_id: "job",
        cron_job_name: "Morning",
      },
      message: { role: "assistant", content: "Original private content" },
    };
    deps = {
      stateDir,
      resolveSession: vi.fn(async () => ({ sessionId: "native-session", busy: false })),
      append: vi.fn(async () => ({
        messageId: "native-message",
        message: { role: "assistant" as const, content: "Stored redacted content" },
      })),
    };
  });
  afterEach(async () => {
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("returns the committed native message rather than the request", async () => {
    const result = await copyMessage(request, deps);
    expect(result).toMatchObject({
      status: "committed",
      copyId: request.copyId,
      sessionId: "native-session",
      messageId: "native-message",
      message: { content: "Stored redacted content" },
    });
  });

  it("serializes concurrent copies and replays the same receipt after restart", async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => copyMessage(request, deps)));
    expect(deps.append).toHaveBeenCalledTimes(1);
    expect(results.every((result) => JSON.stringify(result) === JSON.stringify(results[0]))).toBe(
      true,
    );
    const restart = {
      ...deps,
      append: vi.fn(async () => {
        throw new Error("must not append again");
      }),
    };
    expect(await copyMessage(request, restart)).toEqual(results[0]);
  });

  it("rejects conflicting reuse of a copy identity", async () => {
    await copyMessage(request, deps);
    await expect(
      copyMessage({ ...request, message: { role: "assistant", content: "Different" } }, deps),
    ).rejects.toThrow(/conflict/i);
    await expect(
      copyMessage({ ...request, destinationSessionKey: "agent:main:other" }, deps),
    ).rejects.toThrow(/conflict/i);
  });

  it("defers an active destination without appending", async () => {
    deps.resolveSession = vi.fn(async () => ({ sessionId: "native-session", busy: true }));
    expect(await copyMessage(request, deps)).toEqual({ status: "busy", copyId: request.copyId });
    expect(deps.append).not.toHaveBeenCalled();
  });

  it("keeps the original session epoch when an append response is lost", async () => {
    deps.append = vi.fn(async () => {
      throw new Error("lost reply");
    });
    await expect(copyMessage(request, deps)).rejects.toThrow("lost reply");
    deps.resolveSession = vi.fn(async () => ({ sessionId: "replacement-session", busy: false }));
    await expect(copyMessage(request, deps)).rejects.toThrow(/session changed/i);
    expect(deps.append).toHaveBeenCalledTimes(1);
  });

  it("retains separate equal-text executions", async () => {
    await copyMessage(request, deps);
    await copyMessage({ ...request, copyId: randomUUID(), executionId: randomUUID() }, deps);
    expect(deps.append).toHaveBeenCalledTimes(2);
  });

  it("does not replay a committed receipt into a reset destination", async () => {
    await copyMessage(request, deps);
    deps.resolveSession = vi.fn(async () => ({ sessionId: "replacement-session", busy: false }));
    await expect(copyMessage(request, deps)).rejects.toThrow(/session changed/i);
    expect(deps.append).toHaveBeenCalledTimes(1);
  });
});
