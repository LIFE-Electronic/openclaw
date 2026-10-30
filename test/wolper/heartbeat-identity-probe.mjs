/** Appended to the shared contract; inspect compiled code without module initialization. */
import { readdir as listHeartbeatChunks, readFile as readHeartbeatChunk } from "node:fs/promises";

try {
  let guards = 0;
  let attempts = 0;
  for (const filename of await listHeartbeatChunks("/app/dist")) {
    if (!filename.endsWith(".js")) {
      continue;
    }
    const source = await readHeartbeatChunk("/app/dist/" + filename, "utf8");
    if (/(?:^|\n)function guardSessionManager(?:\$\d+)?\s*\(/.test(source)) {
      verifyHeartbeatPersistenceIdentity(loadHeartbeatPersistenceGuard(source));
      guards += 1;
    }
    if (
      /heartbeatRunId:\s*getAgentRunContext(?:\$\d+)?\(params\.runId\)\?\.isHeartbeat\s*\?\s*params\.runId\s*:\s*(?:undefined|void\s+0)/.test(
        source,
      )
    ) {
      attempts += 1;
    }
  }
  assert.ok(
    guards > 0 && attempts > 0,
    "Installed heartbeat persistence or attempt wiring is missing",
  );
  console.log(
    JSON.stringify({
      ok: true,
      heartbeatRunIdentity: true,
      ordinaryMessagesUnchanged: true,
      attemptWiring: true,
    }),
  );
} catch {
  console.log(JSON.stringify({ error: "Installed heartbeat identity verification failed" }));
}
