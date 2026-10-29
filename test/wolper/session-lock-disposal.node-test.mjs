/** Run the same lock ownership contract against source and compiled-style code. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { test } from "node:test";
import {
  loadSessionLockController,
  verifyLateSessionLockAcquisitionReleased,
  verifySessionLockReacquireAfterDisposeBlocked,
  verifySessionLockDisposal,
} from "./session-lock-disposal-contract.mjs";

const source = process.env.OPENCLAW_PATCHED_SOURCE;
async function nativeText() {
  return stripTypeScriptTypes(
    await readFile(
      path.join(source, "src/agents/embedded-agent-runner/run/attempt.session-lock.ts"),
      "utf8",
    ),
  );
}

test(
  "native disposal releases a prompt lock acquired after abort teardown already finished",
  { skip: !source },
  async () => {
    await verifyLateSessionLockAcquisitionReleased(loadSessionLockController(await nativeText()));
  },
);

test(
  "native prompt finalizer cannot acquire a new retained lock after disposal",
  { skip: !source },
  async () => {
    await verifySessionLockReacquireAfterDisposeBlocked(
      loadSessionLockController(await nativeText()),
    );
  },
);

test(
  "compiled probe binds import aliases without executing surrounding runtime initialization",
  { skip: !source },
  async () => {
    const text = (await nativeText())
      .replace(/\bAsyncLocalStorage\b/g, "AsyncLocalStorage$7")
      .replace(
        /\bcreateEmbeddedAttemptSessionLockController\b/g,
        "createEmbeddedAttemptSessionLockController$3",
      );
    const guarded = `throw new Error('Runtime module initialization must not execute');\n${text}\nthrow new Error('Runtime module tail must not execute');`;
    assert.deepEqual(await verifySessionLockDisposal(loadSessionLockController(guarded)), {
      lateAcquireReleased: true,
      reacquireAfterDisposeBlocked: true,
    });
  },
);
