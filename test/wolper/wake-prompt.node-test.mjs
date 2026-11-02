/** Exercise the production splitter without loading the agent runtime. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";

const moduleUrl = (source) =>
  `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const internal = moduleUrl(
  stripTypeScriptTypes(
    await readFile(
      new URL("../../src/agents/internal-runtime-context.ts", import.meta.url),
      "utf8",
    ),
  ),
);
const source = stripTypeScriptTypes(
  await readFile(
    new URL(
      "../../src/agents/embedded-agent-runner/run/runtime-context-prompt.ts",
      import.meta.url,
    ),
    "utf8",
  ),
).replace('"../../internal-runtime-context.js"', JSON.stringify(internal));
const { resolveRuntimeContextPromptParts } = await import(moduleUrl(source));

test("a heartbeat transcript label never discards its model input without prompt hooks", () => {
  const effectivePrompt = 'System: New event.\nSystem: {"event_id":"event-1","title":"Planning"}';
  const transcriptPrompt = "[OpenClaw heartbeat poll]";
  assert.deepEqual(resolveRuntimeContextPromptParts({ effectivePrompt, transcriptPrompt }), {
    prompt: transcriptPrompt,
    modelPrompt: effectivePrompt,
  });
});

test("ordinary visible prompts still separate runtime context without duplication", () => {
  assert.deepEqual(
    resolveRuntimeContextPromptParts({
      effectivePrompt: "System: Event.\n\nvisible ask",
      transcriptPrompt: "visible ask",
    }),
    { prompt: "visible ask", runtimeContext: "System: Event." },
  );
});
