import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
const source = await readFile(
  new URL("../../src/infra/wolper-compaction-context.ts", import.meta.url),
  "utf8",
);
const { readCompactionContext } = await import(
  "data:text/javascript;base64," +
    Buffer.from(
      (await import("node:module")).stripTypeScriptTypes(
        source.replace(
          "../config/sessions/transcript-stream.js",
          new URL("../../src/config/sessions/transcript-stream.ts", import.meta.url).href,
        ),
      ),
    ).toString("base64")
);
test("native history identity survives replays and excludes maintenance metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-context-"));
  try {
    const file = join(root, "session.jsonl");
    const message = {
      type: "message",
      id: "one",
      timestamp: "2026-11-05T00:00:00Z",
      message: { role: "assistant", content: [] },
    };
    await writeFile(
      file,
      JSON.stringify(message) + "\n" + JSON.stringify({ type: "custom", id: "metadata" }) + "\n",
    );
    assert.deepEqual(await readCompactionContext(file, "epoch"), {
      contextRevision: "epoch:one",
      contextUpdatedAt: Date.parse(message.timestamp),
    });
    await writeFile(
      file,
      JSON.stringify(message) + "\n" + JSON.stringify({ type: "compaction", id: "summary" }) + "\n",
    );
    assert.deepEqual(await readCompactionContext(file, "epoch"), {
      contextRevision: "epoch:one",
      contextUpdatedAt: Date.parse(message.timestamp),
    });
    assert.equal((await readCompactionContext(file, "new-epoch")).contextRevision, "new-epoch:one");
    await writeFile(
      file,
      JSON.stringify(message) +
        "\n" +
        JSON.stringify({ ...message, id: "tool", message: { role: "toolResult" } }) +
        "\n",
    );
    assert.equal((await readCompactionContext(file, "epoch")).contextRevision, "epoch:tool");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
