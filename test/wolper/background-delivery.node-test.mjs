/** Real native queue contract; temporary storage is always removed. */
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import fs from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  loadBackgroundContract,
  verifyBackgroundContract,
} from "./background-delivery-contract.mjs";
import { loadHeartbeatPersistenceGuard } from "./heartbeat-identity-contract.mjs";

const root = process.env.OPENCLAW_PATCHED_SOURCE;
test(
  "native config validator accepts BlueHouse heartbeat delivery without a channel plugin",
  { skip: !root },
  async () => {
    const source = stripTypeScriptTypes(
      await readFile(path.join(root, "src/config/validation.ts"), "utf8"),
    );
    const start = source.indexOf("const validateHeartbeatTarget =");
    const end = source.indexOf("\n  };", start);
    assert.ok(start >= 0 && end > start);
    const issues = [];
    // Execute only repository-owned source extracted for this contract probe.
    // oxlint-disable-next-line typescript/no-implied-eval
    const validate = new Function(
      "issues",
      "normalizeLowercaseStringOrEmpty",
      "normalizeBundledChannelId",
      "heartbeatChannelIds",
      "ensureRegistry",
      source.slice(start, end + 5) + "; return validateHeartbeatTarget;",
    )(
      issues,
      (value) => value.toLowerCase(),
      () => undefined,
      new Set(),
      () => ({ registry: { plugins: [] } }),
    );
    validate("bluehouse", "agents.defaults.heartbeat.target");
    assert.deepEqual(issues, []);
    validate("not-a-channel", "agents.defaults.heartbeat.target");
    assert.equal(issues.length, 1);
  },
);
test("persisted cron-through-heartbeat origin preserves both facts", { skip: !root }, async () => {
  const source = stripTypeScriptTypes(
    await readFile(path.join(root, "src/agents/session-tool-result-guard-wrapper.ts"), "utf8"),
  );
  const persist = loadHeartbeatPersistenceGuard(source);
  const origin = { trigger: "cron", is_heartbeat: true, cron_job_id: "job" };
  const result = persist(
    { role: "assistant", content: "Reminder" },
    { backgroundExecution: { runId: "execution", origin } },
  );
  assert.equal(result["__openclaw"].runId, "execution");
  assert.deepEqual(result["__openclaw"].origin, origin);
});
test(
  "native background execution keeps identity and pending results until a durable receipt",
  { skip: !root },
  async () => {
    // Source contracts run before npm installation in the image build. Stub only
    // the fs-safe adapter; exercise the native identity/queue logic with real files.
    const source = await readFile(path.join(root, "src/infra/wolper-background.ts"), "utf8");
    const runnable = stripTypeScriptTypes(source).replace(
      /import \{ readJsonDurableQueueEntry, writeJsonDurableQueueEntry \} from "@openclaw\/fs-safe\/store";/,
      `async function readJsonDurableQueueEntry(file) { return JSON.parse(await fs.readFile(file, 'utf8')); }
     async function writeJsonDurableQueueEntry({filePath, entry}) {
       const tmp = filePath + '.tmp';
       await fs.writeFile(tmp, JSON.stringify(entry), {mode: 0o600});
       await fs.rename(tmp, filePath);
     }`,
    );
    const native = await import(
      "data:text/javascript;base64," + Buffer.from(runnable).toString("base64")
    );
    const dir = await mkdtemp(path.join(os.tmpdir(), "wolper-background-"));
    try {
      const ids = Array.from({ length: 3 }, () => native.createBackgroundExecution("cron", "job"));
      assert.equal(new Set(ids.map((x) => x.runId)).size, 3);
      assert.ok(ids.every((x) => x.origin.trigger === "cron" && x.origin.cron_job_id === "job"));
      const entries = ids.map((x) => ({
        version: 1,
        executionId: x.runId,
        origin: x.origin,
        sourceSessionKey: "agent:main:cron:job",
        destinationSessionKey: "agent:main:main",
        completedAt: "2026-10-28T12:00:00.000Z",
        outcome: "completed",
        message: { role: "assistant", content: "Reminder" },
      }));
      for (const entry of entries) {
        await native.enqueueBackgroundResult(dir, entry);
      }
      assert.equal(
        (
          await native.backgroundDeliveryStatus(
            dir,
            entries[0].executionId,
            entries[0].destinationSessionKey,
          )
        ).status,
        "pending",
      );
      for (const entry of entries) {
        await native.enqueueBackgroundResult(dir, entry);
      }
      const first = await native.pendingBackgroundResults(dir, { limit: 2 });
      assert.deepEqual(
        first.entries,
        entries.slice(0, 2),
        "Offline results must retain enqueue order",
      );
      assert.equal(first.entries.length, 2);
      assert.equal(first.hasMore, true);
      const second = await native.pendingBackgroundResults(dir, {
        limit: 2,
        after: first.nextCursor,
      });
      assert.equal(second.entries.length, 1);
      assert.equal(second.hasMore, false);
      const entry = entries[0];
      await assert.rejects(
        native.enqueueBackgroundResult(dir, {
          ...entry,
          message: { role: "assistant", content: "Overwrite" },
        }),
        /identity/,
      );
      const receipt = {
        execution_id: entry.executionId,
        destination_session_key: entry.destinationSessionKey,
        status: "delivered",
        row_id: "v2-message-1",
      };
      await native.ackBackgroundResult(dir, receipt);
      await native.ackBackgroundResult(dir, receipt);
      await native.enqueueBackgroundResult(dir, entry);
      assert.equal(
        (await fs.readdir(path.join(dir, "wolper-background", "pending"))).length,
        2,
        "Acknowledged receipts must not remain in the directory polled for pending work",
      );
      assert.equal((await native.pendingBackgroundResults(dir, { limit: 50 })).entries.length, 2);
      assert.deepEqual(
        await native.backgroundReceipt(dir, entry.executionId, entry.destinationSessionKey),
        receipt,
      );
      assert.equal(
        (await native.backgroundDeliveryStatus(dir, entry.executionId, entry.destinationSessionKey))
          .status,
        "delivered",
      );
      assert.equal(
        (await native.backgroundDeliveryStatus(dir, entry.executionId, entry.destinationSessionKey))
          .executionOutcome,
        "completed",
      );
      assert.equal(native.createBackgroundExecution("cron", "job", true).origin.is_heartbeat, true);
      assert.equal(native.createBackgroundExecution("heartbeat").origin.is_heartbeat, true);
      assert.deepEqual(native.defaultBluehouseDelivery(undefined, "webchat"), {
        mode: "bluehouse",
        to: "agent:main:main",
      });
      for (const explicit of [
        { mode: "none" },
        { mode: "announce", channel: "telegram", to: "123" },
        { mode: "bluehouse", to: "agent:main:other" },
        { mode: "webhook", to: "https://example.org" },
      ]) {
        assert.deepEqual(native.defaultBluehouseDelivery(explicit, "webchat"), explicit);
      }
      assert.deepEqual(
        native.defaultBluehouseDelivery({ mode: "announce", channel: "last" }, "webchat"),
        { mode: "bluehouse", to: "agent:main:main" },
      );
      assert.equal(
        native.bluehouseHeartbeatDestination("bluehouse", "agent:main:other"),
        "agent:main:other",
      );
      assert.equal(native.bluehouseHeartbeatDestination("none", "agent:main:main"), undefined);
      assert.equal(native.bluehouseHeartbeatDestination("telegram", "agent:main:main"), undefined);
      assert.equal(
        native.bluehouseHeartbeatDestination("none", "agent:main:cron:job", "agent:main:main"),
        "agent:main:main",
      );
      assert.deepEqual(
        native.backgroundMessage([
          { text: "HEARTBEAT_OK", mediaUrls: ["/tmp/a.mp4", "/tmp/a.mp3", "/tmp/a.png"] },
        ]).content,
        [
          { type: "text", text: "HEARTBEAT_OK" },
          { type: "text", text: "MEDIA:/tmp/a.mp4" },
          { type: "text", text: "MEDIA:/tmp/a.mp3" },
          { type: "text", text: "MEDIA:/tmp/a.png" },
        ],
      );
      assert.deepEqual(
        native.backgroundMessage([{ text: "private", isReasoning: true }]).content,
        [],
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test("cron executor never uses the session UUID as its execution ID", { skip: !root }, async () => {
  const executor = await readFile(
    path.join(root, "src/cron/isolated-agent/run-executor.ts"),
    "utf8",
  );
  assert.doesNotMatch(executor, /runId:\s*params\.cronSession\.sessionEntry\.sessionId/);
  assert.match(executor, /runId:\s*params\.execution\.runId/);
  const runner = await readFile(path.join(root, "src/cron/isolated-agent/run.ts"), "utf8");
  assert.doesNotMatch(runner, /sessionId:\s*initialSessionId/);
});

test("installed-image probe exercises the same source contract", { skip: !root }, async () => {
  const source = stripTypeScriptTypes(
    await readFile(path.join(root, "src/infra/wolper-background.ts"), "utf8"),
  );
  const native = loadBackgroundContract(source, {
    readJsonDurableQueueEntry: async (file) => JSON.parse(await fs.readFile(file, "utf8")),
    writeJsonDurableQueueEntry: async ({ filePath, entry }) => {
      await fs.writeFile(filePath + ".tmp", JSON.stringify(entry), { mode: 0o600 });
      await fs.rename(filePath + ".tmp", filePath);
    },
  });
  assert.equal((await verifyBackgroundContract(native)).ok, true);
});

test("FIFO survives a native restart and a backwards wall clock", { skip: !root }, async () => {
  const source = stripTypeScriptTypes(
    await readFile(path.join(root, "src/infra/wolper-background.ts"), "utf8"),
  );
  const store = {
    readJsonDurableQueueEntry: async (file) => JSON.parse(await fs.readFile(file, "utf8")),
    writeJsonDurableQueueEntry: async ({ filePath, entry }) => {
      await fs.writeFile(filePath + ".tmp", JSON.stringify(entry), { mode: 0o600 });
      await fs.rename(filePath + ".tmp", filePath);
    },
  };
  const dir = await mkdtemp(path.join(os.tmpdir(), "wolper-fifo-"));
  const now = Date.now;
  try {
    const first = loadBackgroundContract(source, store);
    const entry = (id) => ({
      version: 1,
      executionId: id,
      origin: { trigger: "cron", is_heartbeat: false, cron_job_id: "job" },
      sourceSessionKey: "agent:main:cron:job",
      destinationSessionKey: "agent:main:main",
      completedAt: new Date().toISOString(),
      outcome: "completed",
      message: { role: "assistant", content: "Reminder" },
    });
    await first.enqueueBackgroundResult(dir, entry("first"));
    Date.now = () => 1000;
    const restarted = loadBackgroundContract(source, store);
    await restarted.enqueueBackgroundResult(dir, entry("second"));
    assert.deepEqual(
      (await restarted.pendingBackgroundResults(dir, {})).entries.map((x) => x.executionId),
      ["first", "second"],
    );
  } finally {
    Date.now = now;
    await rm(dir, { recursive: true, force: true });
  }
});

// Exercise the fork's actual module, rather than retaining a second source copy.
test("patched background queue preserves cron name snapshots", async () => {
  const source = await readFile(path.join(root, "src/infra/wolper-background.ts"), "utf8");
  const runnable = stripTypeScriptTypes(source);
  const native = loadBackgroundContract(runnable, {
    readJsonDurableQueueEntry: async (file) => JSON.parse(await fs.readFile(file, "utf8")),
    writeJsonDurableQueueEntry: async ({ filePath, entry }) =>
      fs.writeFile(filePath, JSON.stringify(entry)),
  });
  assert.equal((await verifyBackgroundContract(native)).cronJobName, true);
});
