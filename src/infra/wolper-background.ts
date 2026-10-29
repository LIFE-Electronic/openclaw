/** Durable BlueHouse results. Only a committed backend receipt retires an entry. */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { readJsonDurableQueueEntry, writeJsonDurableQueueEntry } from "@openclaw/fs-safe/store";
import type { ReplyPayload } from "../auto-reply/types.js";
import type { CronDelivery } from "../cron/types.js";

export type WolperOrigin = {
  trigger: "user" | "heartbeat" | "cron" | "unknown";
  is_heartbeat: boolean;
  cron_job_id: string | null;
  cron_job_name?: string | null;
};
export type BackgroundExecution = {
  runId: string;
  origin: WolperOrigin;
  destinationSessionKey?: string;
};
export type BackgroundResult = {
  version: 1;
  executionId: string;
  origin: WolperOrigin;
  sourceSessionKey: string;
  destinationSessionKey: string;
  completedAt: string;
  outcome: "completed" | "failed" | "silent";
  message: Record<string, unknown>;
};
export type BackgroundReceipt = {
  execution_id: string;
  destination_session_key: string;
  status: "delivered" | "suppressed" | "cancelled";
  row_id: string | null;
};
type QueueRecord = {
  digest: string;
  queuedAt: number;
  outcome?: BackgroundResult["outcome"];
  result?: BackgroundResult;
  receipt?: BackgroundReceipt;
};
/** Pure contract factory also exercised against the installed compiled image. */
export type BackgroundDependencies = {
  fs: typeof fs;
  path: typeof path;
  createHash: typeof createHash;
  randomUUID: typeof randomUUID;
  readJsonDurableQueueEntry: typeof readJsonDurableQueueEntry;
  writeJsonDurableQueueEntry: typeof writeJsonDurableQueueEntry;
};
export function createWolperBackgroundContract(deps: BackgroundDependencies) {
  const {
    fs,
    path,
    createHash,
    randomUUID,
    readJsonDurableQueueEntry,
    writeJsonDurableQueueEntry,
  } = deps;

  /** Explicit destinations win; webchat's implicit last-channel fallback never does. */
  function defaultBluehouseDelivery(
    delivery: CronDelivery | undefined,
    channel?: string,
  ): CronDelivery | undefined {
    if (
      channel !== "webchat" ||
      delivery?.mode === "none" ||
      delivery?.mode === "webhook" ||
      delivery?.mode === "bluehouse" ||
      (delivery?.mode === "announce" &&
        delivery.channel &&
        !["last", "webchat"].includes(delivery.channel))
    ) {
      return delivery;
    }
    return { mode: "bluehouse", to: "agent:main:main" };
  }

  function bluehouseHeartbeatDestination(
    target?: string,
    session?: string,
    executionDestination?: string,
  ): string | undefined {
    if (executionDestination) {
      return executionDestination;
    }
    if (target && target !== "bluehouse") {
      return undefined;
    }
    return session?.startsWith("agent:") ? session : "agent:main:main";
  }

  /** Keep attachment types intact through the shared MEDIA directive parser. */
  function backgroundMessage(payloads: ReplyPayload[]): Record<string, unknown> {
    const content: { type: "text"; text: string }[] = [];
    for (const payload of payloads) {
      if (payload.isReasoning || payload.isReasoningSnapshot) {
        continue;
      }
      if (payload.text) {
        content.push({ type: "text", text: payload.text });
      }
      for (const url of new Set([
        ...(payload.mediaUrls ?? []),
        ...(payload.mediaUrl ? [payload.mediaUrl] : []),
      ])) {
        content.push({ type: "text", text: `MEDIA:${url}` });
      }
    }
    return { role: "assistant", content };
  }

  /** One UUID per invocation, shared by fallbacks and every representation of it. */
  function createBackgroundExecution(
    trigger: "cron" | "heartbeat",
    jobId?: string,
    heartbeat = false,
    jobName?: string,
  ): BackgroundExecution {
    if (trigger === "cron" && !jobId) {
      throw new Error("Cron execution requires a job identity");
    }
    return {
      runId: randomUUID(),
      origin: {
        trigger,
        is_heartbeat: heartbeat || trigger === "heartbeat",
        cron_job_id: jobId ?? null,
        cron_job_name: jobName ?? null,
      },
    };
  }

  function queueDir(stateDir: string): string {
    return path.join(stateDir, "wolper-background");
  }
  function recordFiles(
    stateDir: string,
    executionId: string,
    destination: string,
  ): { pending: string; receipt: string } {
    const name = identity(executionId, destination) + ".json";
    return {
      pending: path.join(queueDir(stateDir), "pending", name),
      receipt: path.join(queueDir(stateDir), "receipts", name),
    };
  }
  function identity(executionId: string, destination: string): string {
    if (!executionId || !destination) {
      throw new Error("Missing background identity");
    }
    return createHash("sha256")
      .update(JSON.stringify([executionId, destination]))
      .digest("hex");
  }
  function canonical(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map(canonical);
    }
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value)
          .toSorted(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => [key, canonical(item)]),
      );
    }
    return value;
  }
  function digest(value: unknown): string {
    return createHash("sha256")
      .update(JSON.stringify(canonical(value)))
      .digest("hex");
  }
  const writes = new Map<string, Promise<unknown>>();
  async function serialized<T>(file: string, action: () => Promise<T>): Promise<T> {
    const previous = writes.get(file) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(action);
    writes.set(file, next);
    try {
      return await next;
    } finally {
      if (writes.get(file) === next) {
        writes.delete(file);
      }
    }
  }
  async function readRecord(file: string): Promise<QueueRecord | undefined> {
    try {
      return await readJsonDurableQueueEntry<QueueRecord>(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  }
  async function writeRecord(file: string, entry: QueueRecord): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeJsonDurableQueueEntry({ filePath: file, entry, tempPrefix: ".wolper-background" });
  }

  async function enqueueBackgroundResult(
    stateDir: string,
    result: BackgroundResult,
    keepFirstTerminal = false,
  ): Promise<void> {
    const files = recordFiles(stateDir, result.executionId, result.destinationSessionKey);
    await serialized(queueDir(stateDir), async () => {
      const previous = (await readRecord(files.receipt)) ?? (await readRecord(files.pending));
      const fingerprint = digest(result);
      if (previous) {
        // A watchdog abort can win a race with late model completion. Native
        // producers keep that first terminal result; receivers still reject conflicts.
        if (keepFirstTerminal) {
          return;
        }
        if (previous.digest !== fingerprint) {
          throw new Error("Background execution identity conflict");
        }
        return; // Includes already acknowledged results: never reopen them.
      }
      // A durable ordinal survives process restarts and wall-clock corrections.
      // Persist the counter first: a crash may leave a gap, never reused order.
      const counterFile = path.join(queueDir(stateDir), "sequence.json");
      let ordinal = 0;
      try {
        ordinal = (await readJsonDurableQueueEntry<{ ordinal: number }>(counterFile))?.ordinal ?? 0;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
      await fs.mkdir(queueDir(stateDir), { recursive: true, mode: 0o700 });
      await writeJsonDurableQueueEntry({
        filePath: counterFile,
        entry: { ordinal: ordinal + 1 },
        tempPrefix: ".wolper-background",
      });
      await writeRecord(files.pending, {
        digest: fingerprint,
        queuedAt: ordinal + 1,
        outcome: result.outcome,
        result,
      });
    });
  }

  async function pendingBackgroundResults(
    stateDir: string,
    options: { limit?: number; after?: string },
  ): Promise<{
    version: 1;
    entries: BackgroundResult[];
    hasMore: boolean;
    nextCursor: string | null;
  }> {
    const limit = Math.min(200, Math.max(1, options.limit ?? 50));
    let files: string[];
    const pendingDir = path.join(queueDir(stateDir), "pending");
    try {
      files = await fs.readdir(pendingDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        files = [];
      } else {
        throw error;
      }
    }
    const pending: { cursor: string; result: BackgroundResult }[] = [];
    for (const file of files.filter((name) => /^[a-f0-9]{64}\.json$/.test(name))) {
      const record = await readRecord(path.join(pendingDir, file));
      if (!record?.result || record.receipt) {
        continue;
      }
      // A crash after persisting a receipt but before unlinking its pending file
      // must not reopen delivery. Polling never scans historical receipt files.
      if (await readRecord(path.join(queueDir(stateDir), "receipts", file))) {
        continue;
      }
      pending.push({
        cursor: `${record.queuedAt.toFixed(3).padStart(18, "0")}:${file}`,
        result: record.result,
      });
    }
    pending.sort((a, b) => a.cursor.localeCompare(b.cursor));
    const entries: BackgroundResult[] = [];
    let cursor: string | null = null;
    for (const item of pending) {
      if (options.after && item.cursor <= options.after) {
        continue;
      }
      if (entries.length === limit) {
        return { version: 1, entries, hasMore: true, nextCursor: cursor };
      }
      entries.push(item.result);
      cursor = item.cursor;
    }
    return { version: 1, entries, hasMore: false, nextCursor: null };
  }

  async function ackBackgroundResult(stateDir: string, receipt: BackgroundReceipt): Promise<void> {
    if (
      !["delivered", "suppressed", "cancelled"].includes(receipt.status) ||
      (receipt.status === "delivered" && !/^v2-message-[1-9][0-9]*$/.test(receipt.row_id ?? ""))
    ) {
      throw new Error("A delivered background result requires a committed transcript row");
    }
    const files = recordFiles(stateDir, receipt.execution_id, receipt.destination_session_key);
    await serialized(queueDir(stateDir), async () => {
      const previous = (await readRecord(files.receipt)) ?? (await readRecord(files.pending));
      if (!previous) {
        throw new Error("Unknown background execution");
      }
      if (previous.receipt && digest(previous.receipt) !== digest(receipt)) {
        throw new Error("Conflicting background receipt");
      }
      // Persist the small receipt first, then retire the message payload. Sharing
      // the enqueue lock prevents a concurrent retry from reopening this entry.
      await writeRecord(files.receipt, {
        digest: previous.digest,
        queuedAt: previous.queuedAt,
        outcome: previous.outcome,
        receipt,
      });
      try {
        await fs.unlink(files.pending);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
    });
  }

  async function backgroundReceipt(
    stateDir: string,
    executionId: string,
    destination: string,
  ): Promise<BackgroundReceipt | undefined> {
    return (await readRecord(recordFiles(stateDir, executionId, destination).receipt))?.receipt;
  }

  /** Execution completion is not delivery: only an acknowledged row is delivered. */
  async function backgroundDeliveryStatus(
    stateDir: string,
    executionId: string,
    destination: string,
  ): Promise<{
    version: 1;
    executionId: string;
    destinationSessionKey: string;
    status: "unknown" | "pending" | BackgroundReceipt["status"];
    rowId: string | null;
    executionOutcome: BackgroundResult["outcome"] | "unknown";
  }> {
    const files = recordFiles(stateDir, executionId, destination);
    const record = (await readRecord(files.receipt)) ?? (await readRecord(files.pending));
    return {
      version: 1,
      executionId,
      destinationSessionKey: destination,
      status: record?.receipt?.status ?? (record?.result ? "pending" : "unknown"),
      rowId: record?.receipt?.row_id ?? null,
      executionOutcome: record?.outcome ?? "unknown",
    };
  }
  return {
    defaultBluehouseDelivery,
    bluehouseHeartbeatDestination,
    backgroundMessage,
    createBackgroundExecution,
    enqueueBackgroundResult,
    pendingBackgroundResults,
    ackBackgroundResult,
    backgroundReceipt,
    backgroundDeliveryStatus,
  };
}

export const {
  defaultBluehouseDelivery,
  bluehouseHeartbeatDestination,
  backgroundMessage,
  createBackgroundExecution,
  enqueueBackgroundResult,
  pendingBackgroundResults,
  ackBackgroundResult,
  backgroundReceipt,
  backgroundDeliveryStatus,
} = createWolperBackgroundContract({
  fs,
  path,
  createHash,
  randomUUID,
  readJsonDurableQueueEntry,
  writeJsonDurableQueueEntry,
});
