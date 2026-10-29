import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionManager } from "../agents/sessions/session-manager.js";
import { replyRunRegistry } from "../auto-reply/reply/reply-run-registry.js";
import { resolveDefaultSessionStorePath } from "../config/sessions/paths.js";
import { materializeBackgroundResult } from "./wolper-background-runtime.js";
import { copyIntoSession } from "./wolper-message-copy-runtime.js";
import type { CopyRequest } from "./wolper-message-copy.js";

vi.mock("../config/config.js", () => ({ getRuntimeConfig: () => ({}) }));
let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "wolper-native-copy-"));
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

it("publishes exactly the stored message and makes it available in the next model context", async () => {
  const request: CopyRequest = {
    copyId: randomUUID(),
    executionId: randomUUID(),
    destinationSessionKey: "agent:main:dashboard:imessage-copy",
    origin: { trigger: "heartbeat", is_heartbeat: true, cron_job_id: null },
    message: { role: "assistant", content: "Your appointment is tomorrow." },
  };
  const receipt = await copyIntoSession(request);
  expect(receipt.status).toBe("committed");
  if (receipt.status !== "committed") {
    throw new Error("copy was not committed");
  }
  const file = path.join(
    path.dirname(resolveDefaultSessionStorePath("main")),
    `${receipt.sessionId}.jsonl`,
  );
  const entries = (await fs.readFile(file, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const message = entries.find((entry) => entry.id === receipt.messageId);
  expect(message?.message).toEqual(receipt.message);
  expect(message).toHaveProperty("parentId");
  expect(await copyIntoSession(request)).toEqual(receipt);
  expect((await fs.readFile(file, "utf8")).trim().split("\n")).toHaveLength(entries.length);
  const session = SessionManager.open(file);
  expect(session.buildSessionContext().messages).toContainEqual(receipt.message);
  expect(receipt.message["__openclaw"]).toMatchObject({
    copyId: request.copyId,
    runId: request.executionId,
    origin: request.origin,
  });
  // Simulate dying after transcript commit but before the receipt was saved.
  const receiptFile = path.join(root, "wolper-message-copies", `${request.copyId}.json`);
  const prepared = JSON.parse(await fs.readFile(receiptFile, "utf8"));
  delete prepared.receipt;
  await fs.writeFile(receiptFile, JSON.stringify(prepared));
  expect(await copyIntoSession(request)).toEqual(receipt);
  expect((await fs.readFile(file, "utf8")).trim().split("\n")).toHaveLength(entries.length);
});

it("defers while a real destination reply operation is active", async () => {
  const request: CopyRequest = {
    copyId: randomUUID(),
    executionId: randomUUID(),
    destinationSessionKey: "agent:main:dashboard:busy",
    origin: { trigger: "heartbeat", is_heartbeat: true, cron_job_id: null },
    message: { role: "assistant", content: "Reminder" },
  };
  const operation = replyRunRegistry.begin({
    sessionKey: request.destinationSessionKey,
    sessionId: "active",
    resetTriggered: false,
  });
  try {
    expect(await copyIntoSession(request)).toEqual({ status: "busy", copyId: request.copyId });
  } finally {
    operation.complete();
  }
  expect((await copyIntoSession(request)).status).toBe("committed");
});

it("materializes Main even if background output names a different destination", async () => {
  await materializeBackgroundResult({
    version: 1,
    executionId: randomUUID(),
    sourceSessionKey: "agent:main:cron:job",
    destinationSessionKey: "agent:main:dashboard:chosen",
    completedAt: new Date().toISOString(),
    outcome: "completed",
    origin: { trigger: "heartbeat", is_heartbeat: true, cron_job_id: null },
    message: { role: "assistant", content: "A useful reminder" },
  });
  const store = JSON.parse(await fs.readFile(resolveDefaultSessionStorePath("main"), "utf8"));
  for (const key of ["agent:main:main", "agent:main:dashboard:chosen"]) {
    expect(store[key]).toBeDefined();
    expect(
      SessionManager.open(store[key].sessionFile).buildSessionContext().messages,
    ).toMatchObject([
      { role: "assistant", content: [{ type: "text", text: "A useful reminder" }] },
    ]);
  }
});
