import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
/** Verify actual native writes in isolated storage, including a process restart. */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Each child loads the installed implementation after its private state/config
// paths are set. No live transcript, owner configuration or Gateway is opened.
async function writeBatch(ids) {
  const fs = await import("node:fs/promises");
  let materialize;
  for (const file of await fs.readdir("/app/dist")) {
    if (!file.endsWith(".js")) {
      continue;
    }
    const source = await fs.readFile("/app/dist/" + file, "utf8");
    if (!/function materializeBackgroundResult\(/.test(source)) {
      continue;
    }
    const module = await import("/app/dist/" + file);
    materialize = Object.values(module).find(
      (value) => typeof value === "function" && value.name === "materializeBackgroundResult",
    );
    if (materialize) {
      break;
    }
  }
  if (!materialize) {
    throw new Error("Missing materializer");
  }
  const result = (id) => ({
    version: 1,
    executionId: id,
    origin: {
      trigger: "cron",
      is_heartbeat: false,
      cron_job_id: "12345678-1234-1234-1234-123456789abc",
    },
    sourceSessionKey: "agent:main:cron:test",
    destinationSessionKey: "agent:main:main",
    completedAt: "2026-10-28T12:00:00.000Z",
    outcome: "completed",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "Same reminder; token=sk-testonlyabcdefghijklmnopqrstuvwxyz" },
      ],
    },
  });
  await Promise.all(ids.map((id) => materialize(result(id))));
}

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wolper-background-transcript-"));
let stage = "setup";
try {
  const config = path.join(dir, "openclaw.json");
  await fs.writeFile(config, JSON.stringify({ logging: { redactSensitive: "tools" } }), {
    mode: 0o600,
  });
  const first =
    "cron:12345678-1234-1234-1234-123456789abc:1793218657304:abcdefab-1234-1234-1234-123456789abc";
  const second =
    "cron:12345678-1234-1234-1234-123456789abc:1793218957308:abcdefab-1234-1234-1234-123456789abd";
  function write(ids) {
    const child = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", `await (${writeBatch.toString()})(${JSON.stringify(ids)});`],
      {
        env: { ...process.env, OPENCLAW_STATE_DIR: dir, OPENCLAW_CONFIG_PATH: config },
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    assert.equal(child.status, 0, "Isolated native writer failed");
  }
  stage = "concurrent-writes";
  write(Array(30).fill(first));
  // Loading a new process must use the on-disk identity, not an in-memory cache.
  stage = "restart-replay";
  write([first, first, second]);
  stage = "persisted-state";
  const sessions = path.join(dir, "agents/main/sessions");
  const store = JSON.parse(await fs.readFile(path.join(sessions, "sessions.json"), "utf8"));
  const main = store["agent:main:main"];
  const lines = (
    await fs.readFile(main.sessionFile ?? path.join(sessions, main.sessionId + ".jsonl"), "utf8")
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const messages = lines
    .filter((line) => line.type === "message" && line.message.role === "assistant")
    .map((line) => line.message);
  assert.equal(messages.length, 2, "Concurrent/restarted polling duplicated an execution");
  assert.deepEqual(
    messages.map((message) => message["__openclaw"].runId),
    [first, second],
  );
  assert.deepEqual(
    messages.map((message) => message.idempotencyKey),
    [first, second].map((id) => "wolper-background:" + id),
  );
  assert.ok(messages.every((message) => message["__openclaw"].origin.trigger === "cron"));
  assert.ok(
    messages.every(
      (message) =>
        !JSON.stringify(message.content).includes("sk-testonlyabcdefghijklmnopqrstuvwxyz"),
    ),
  );
  console.log(
    JSON.stringify({
      ok: true,
      exactExecutionIdentity: true,
      idempotentTranscript: true,
      restartReplay: true,
      contentRedacted: true,
    }),
  );
} catch {
  console.log(JSON.stringify({ error: "Background transcript verification failed", stage }));
  process.exitCode = 1;
} finally {
  await fs.rm(dir, { recursive: true, force: true });
}
