import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";

// CI can exercise the exact added native module without downloading upstream.
async function nativeModule() {
  let source;
  if (process.env.OPENCLAW_PATCHED_SOURCE) {
    source = await readFile(
      process.env.OPENCLAW_PATCHED_SOURCE + "/src/agents/cron-tool-validation.ts",
      "utf8",
    );
  } else {
    const patch = await readFile(
      new URL("./zzz-cron-tool-validation.patch", import.meta.url),
      "utf8",
    );
    const section = patch
      .split(
        "diff --git a/src/agents/cron-tool-validation.ts b/src/agents/cron-tool-validation.ts\n",
      )[1]
      ?.split("\ndiff --git ")[0];
    assert(section, "native error formatter must be present in the shipped patch");
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

test("cron creation errors name nested job paths and provide a complete repair example", async () => {
  const { cronAddValidationMessage, CRON_ADD_EXAMPLE } = await nativeModule();
  const message = cronAddValidationMessage([
    { keyword: "required", instancePath: "", params: { missingProperty: "schedule" } },
    {
      keyword: "additionalProperties",
      instancePath: "",
      params: { additionalProperty: "scheduleEnd" },
    },
    { keyword: "required", instancePath: "/payload", params: { missingProperty: "message" } },
  ]);
  assert.match(message, /job\.schedule: required/);
  assert.match(message, /job\.scheduleEnd: unknown field/);
  assert.match(message, /job\.payload\.message: required/);
  assert.match(message, /Example cron call:/);
  assert.deepEqual(JSON.parse(message.split("Example cron call:\n")[1]), CRON_ADD_EXAMPLE);
  assert.equal(CRON_ADD_EXAMPLE.action, "add");
  assert.equal(CRON_ADD_EXAMPLE.job.schedule.kind, "every");
  assert.equal(CRON_ADD_EXAMPLE.job.sessionTarget, "isolated");
  assert.equal(CRON_ADD_EXAMPLE.job.payload.kind, "agentTurn");
});

test("TypeBox array error parameters are reported without dropping distinct issues", async () => {
  const { cronAddValidationMessage } = await nativeModule();
  const message = cronAddValidationMessage([
    {
      keyword: "required",
      instancePath: "",
      params: { requiredProperties: ["schedule", "payload"] },
    },
    {
      keyword: "additionalProperties",
      instancePath: "",
      params: { additionalProperties: ["scheduleNested", "sessionTarget_kind"] },
    },
    { keyword: "minimum", instancePath: "/schedule/everyMs", message: "must be >= 1" },
  ]);
  for (const path of [
    "job.schedule",
    "job.payload",
    "job.scheduleNested",
    "job.sessionTarget_kind",
    "job.schedule.everyMs",
  ]) {
    assert(message.includes(path), path);
  }
  assert.match(message, /must be >= 1/);
});

test("gateway validation retains its reason and clarifies that root means job", async () => {
  const { cronAddGatewayValidationMessage } = await nativeModule();
  const original =
    "invalid cron.add params: must have required property 'schedule'; at root: unexpected property 'scheduleX'";
  const message = cronAddGatewayValidationMessage(original);
  assert(message.includes(original));
  assert.match(message, /relative to job/);
  assert.match(message, /Example cron call:/);
});
