import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CompactionOperations } from "../../src/infra/wolper-compaction.ts";

test("durable operation replay does not compact twice; busy does not invoke compact", async () => {
  const root = await mkdtemp(join(tmpdir(), "compact-test-"));
  try {
    const ops = new CompactionOperations(root);
    let calls = 0;
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    const run = async () => {
      calls++;
      await gate;
      return { ok: true, compacted: true };
    };
    assert.equal((await ops.start("one", "session", () => false, run)).state, "running");
    assert.equal((await ops.start("one", "session", () => false, run)).state, "running");
    assert.equal((await ops.start("two", "session", () => false, run)).state, "skipped");
    release();
    await ops.drain();
    assert.equal((await ops.status("one", "session")).state, "completed");
    assert.equal(
      (await new CompactionOperations(root).start("one", "session", () => false, run)).state,
      "completed",
    );
    assert.equal(calls, 1);
    assert.equal((await ops.start("busy", "other", () => true, run)).state, "skipped");
    assert.equal(calls, 1);
    await assert.rejects(() => ops.start("one", "different", () => false, run));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed operations are durable and cannot be mistaken for completion", async () => {
  const root = await mkdtemp(join(tmpdir(), "compact-test-"));
  try {
    const ops = new CompactionOperations(root);
    await ops.start(
      "error",
      "session",
      () => false,
      async () => {
        throw new Error("private error");
      },
    );
    await ops.drain();
    assert.equal((await ops.status("error", "session")).state, "failed");
    assert.ok(!JSON.stringify(await ops.status("error", "session")).includes("private"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
