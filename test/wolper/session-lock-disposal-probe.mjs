/** Appended to the shared contract; never imports installed runtime modules. */
import { readdir as listLockChunks, readFile as readLockChunk } from "node:fs/promises";

try {
  let checked = 0;
  for (const filename of await listLockChunks("/app/dist")) {
    if (!filename.endsWith(".js")) {
      continue;
    }
    const text = await readLockChunk("/app/dist/" + filename, "utf8");
    if (!sessionLockControllerPattern.test(text)) {
      continue;
    }
    await verifySessionLockDisposal(loadSessionLockController(text));
    checked += 1;
  }
  assert.ok(checked > 0, "Installed native session lock controller is missing");
  console.log(
    JSON.stringify({ ok: true, lateAcquireReleased: true, reacquireAfterDisposeBlocked: true }),
  );
} catch (error) {
  // Only compiled source and synthetic lock fixtures enter this contract.
  console.log(
    JSON.stringify({
      error: "Installed session lock disposal verification failed",
      detail: String(error),
    }),
  );
}
