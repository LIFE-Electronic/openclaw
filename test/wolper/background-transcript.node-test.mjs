import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";

async function nativeModule() {
  let source;
  if (process.env.OPENCLAW_PATCHED_SOURCE) {
    source = await readFile(
      process.env.OPENCLAW_PATCHED_SOURCE + "/src/agents/wolper-background-identity.ts",
      "utf8",
    );
  } else {
    const patch = await readFile(
      new URL("./zz-background-delivery.patch", import.meta.url),
      "utf8",
    );
    const section = patch
      .split(
        "diff --git a/src/agents/wolper-background-identity.ts b/src/agents/wolper-background-identity.ts\n",
      )[1]
      ?.split("\ndiff --git ")[0];
    assert(section, "the shipped patch must preserve background protocol identities");
    source = section
      .split("\n")
      .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
      .map((line) => line.slice(1))
      .join("\n");
  }
  return import(
    "data:text/javascript;base64," + Buffer.from(stripTypeScriptTypes(source)).toString("base64")
  );
}

const job = "12345678-1234-1234-1234-123456789abc";
const uuid = "abcdefab-1234-1234-1234-123456789abc";

test("only native execution and matching materialization keys survive transcript redaction", async () => {
  const { preserveBackgroundTranscriptIdentity: preserve } = await nativeModule();
  for (const runId of [
    `cron:${job}:1793218657304:${uuid}`,
    `manual:${job}:1793218657304:1`,
    uuid,
  ]) {
    const original = {
      role: "assistant",
      content: "secret content",
      apiKey: "secret",
      idempotencyKey: `wolper-background:${runId}`,
      __openclaw: {
        runId,
        origin: { trigger: "cron", is_heartbeat: false, cron_job_id: job },
        privateNote: "secret",
      },
    };
    const redacted = {
      ...original,
      content: "[REDACTED]",
      apiKey: "[REDACTED]",
      idempotencyKey: "masked",
      __openclaw: { ...original["__openclaw"], runId: "masked", privateNote: "[REDACTED]" },
    };
    const saved = preserve(original, redacted);
    assert.equal(saved["__openclaw"].runId, runId);
    assert.equal(saved.idempotencyKey, original.idempotencyKey);
    assert.equal(saved.content, "[REDACTED]");
    assert.equal(saved.apiKey, "[REDACTED]");
    assert.equal(saved["__openclaw"].privateNote, "[REDACTED]");
    assert.equal(redacted["__openclaw"].runId, "masked", "do not mutate the redactor output");
  }
});

test("untrusted IDs, mismatched keys and ordinary messages retain redaction", async () => {
  const { preserveBackgroundTranscriptIdentity: preserve } = await nativeModule();
  const redacted = {
    role: "assistant",
    content: "[REDACTED]",
    idempotencyKey: "[REDACTED]",
    __openclaw: { runId: "[REDACTED]" },
  };
  for (const original of [
    {
      role: "assistant",
      __openclaw: {
        runId: "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ",
        origin: { trigger: "cron", cron_job_id: job },
      },
    },
    { role: "user", __openclaw: { runId: uuid, origin: { trigger: "cron", cron_job_id: job } } },
    { role: "assistant", __openclaw: { runId: uuid, origin: { trigger: "user" } } },
    { role: "assistant", __openclaw: { runId: uuid } },
  ]) {
    assert.deepEqual(preserve(original, redacted), redacted);
  }
  const saved = preserve(
    {
      role: "assistant",
      idempotencyKey: "unrelated-secret",
      __openclaw: { runId: uuid, origin: { trigger: "heartbeat" } },
    },
    redacted,
  );
  assert.equal(saved["__openclaw"].runId, uuid);
  assert.equal(saved.idempotencyKey, "[REDACTED]");
});
