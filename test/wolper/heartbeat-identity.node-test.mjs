import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { test } from "node:test";
import {
  loadHeartbeatPersistenceGuard,
  verifyHeartbeatPersistenceIdentity,
} from "./heartbeat-identity-contract.mjs";

const root = process.env.OPENCLAW_PATCHED_SOURCE;
test(
  "native persistence gives heartbeat answers a durable run identity",
  { skip: !root },
  async () => {
    const source = await readFile(
      path.join(root, "src/agents/session-tool-result-guard-wrapper.ts"),
      "utf8",
    );
    verifyHeartbeatPersistenceIdentity(loadHeartbeatPersistenceGuard(stripTypeScriptTypes(source)));
  },
);
test(
  "native attempt passes heartbeat identity only for a registered heartbeat run",
  { skip: !root },
  async () => {
    const source = await readFile(
      path.join(root, "src/agents/embedded-agent-runner/run/attempt.ts"),
      "utf8",
    );
    assert.ok(
      /heartbeatRunId:\s*getAgentRunContext\(params\.runId\)\?\.isHeartbeat\s*\?\s*params\.runId\s*:\s*undefined/.test(
        source,
      ),
      "Attempt does not bind the registered heartbeat run to its writer",
    );
  },
);
