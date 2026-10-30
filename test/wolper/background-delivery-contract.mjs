/** Run the actual queue implementation with disposable files and no Gateway. */
import backgroundAssert from "node:assert/strict";
import { createHash as backgroundHash, randomUUID as backgroundUuid } from "node:crypto";
import backgroundFs from "node:fs/promises";
import backgroundOs from "node:os";
import backgroundPath from "node:path";

export function loadBackgroundContract(source, durableStore) {
  const match = /(?:^|\n)(?:export )?function createWolperBackgroundContract(?:\$\d+)?\s*\(/.exec(
    source,
  );
  backgroundAssert.ok(match, "Native background contract factory is missing");
  const start = source.indexOf("function ", match.index);
  const end = source.indexOf("\n}", start);
  backgroundAssert.ok(end > start, "Native background contract boundary is missing");
  // Execute only repository-owned source extracted for this contract probe.
  // oxlint-disable-next-line typescript/no-implied-eval
  const factory = new Function("__name", `return (${source.slice(start, end + 2)});`)((fn) => fn);
  return factory({
    fs: backgroundFs,
    path: backgroundPath,
    createHash: backgroundHash,
    randomUUID: backgroundUuid,
    ...durableStore,
  });
}

export async function verifyBackgroundContract(native) {
  const dir = await backgroundFs.mkdtemp(
    backgroundPath.join(backgroundOs.tmpdir(), "wolper-delivery-probe-"),
  );
  try {
    const entries = Array.from({ length: 3 }, () => {
      const execution = native.createBackgroundExecution(
        "cron",
        "probe-job",
        true,
        "Morning briefing ☀️",
      );
      return {
        version: 1,
        executionId: execution.runId,
        origin: execution.origin,
        sourceSessionKey: "agent:main:cron:probe",
        destinationSessionKey: "agent:main:main",
        completedAt: "2026-10-28T12:00:00.000Z",
        outcome: "completed",
        message: { role: "assistant", content: "Same answer" },
      };
    });
    backgroundAssert.equal(new Set(entries.map((e) => e.executionId)).size, 3);
    for (const entry of entries) {
      await native.enqueueBackgroundResult(dir, entry);
    }
    backgroundAssert.deepEqual(
      (await native.pendingBackgroundResults(dir, { limit: 2 })).entries,
      entries.slice(0, 2),
    );
    const first = entries[0];
    backgroundAssert.equal(first.origin.cron_job_name, "Morning briefing ☀️");
    backgroundAssert.equal(
      native.createBackgroundExecution("heartbeat").origin.cron_job_name,
      null,
    );
    await backgroundAssert.rejects(
      native.ackBackgroundResult(dir, {
        execution_id: first.executionId,
        destination_session_key: first.destinationSessionKey,
        status: "delivered",
        row_id: null,
      }),
    );
    const receipt = {
      execution_id: first.executionId,
      destination_session_key: first.destinationSessionKey,
      status: "delivered",
      row_id: "v2-message-27",
    };
    await native.ackBackgroundResult(dir, receipt);
    await native.ackBackgroundResult(dir, receipt);
    await native.enqueueBackgroundResult(dir, first);
    backgroundAssert.deepEqual(
      (await native.pendingBackgroundResults(dir, {})).entries,
      entries.slice(1),
    );
    backgroundAssert.equal(
      (await native.backgroundDeliveryStatus(dir, first.executionId, first.destinationSessionKey))
        .rowId,
      receipt.row_id,
    );
    backgroundAssert.deepEqual(native.defaultBluehouseDelivery(undefined, "webchat"), {
      mode: "bluehouse",
      to: "agent:main:main",
    });
    return {
      ok: true,
      pendingProtocol: true,
      uniqueExecutions: true,
      durableReceipts: true,
      defaultMain: true,
      cronJobName: true,
    };
  } finally {
    await backgroundFs.rm(dir, { recursive: true, force: true });
  }
}
