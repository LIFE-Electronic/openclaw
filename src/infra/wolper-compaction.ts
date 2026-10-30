/** Durable, idempotent native operation receipts; scheduling belongs to Wolper. */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const bootId = randomUUID();
export type CompactionReceipt = {
  operationId: string;
  key: string;
  bootId: string;
  state: "running" | "completed" | "skipped" | "failed" | "interrupted";
  result?: { sessionId?: string; compacted: boolean; reason?: string };
};

export class CompactionOperations {
  private root: string;
  private active = new Set<string>();
  private tasks = new Set<Promise<void>>();
  private serial: Promise<void> = Promise.resolve();

  constructor(root: string) {
    this.root = join(root, "wolper-compaction");
  }
  busy(key: string): boolean {
    return this.active.has(key);
  }
  private path(id: string): string {
    return join(this.root, createHash("sha256").update(id).digest("hex") + ".json");
  }
  private async save(receipt: CompactionReceipt): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const path = this.path(receipt.operationId);
    const temporary = path + "." + randomUUID();
    await writeFile(temporary, JSON.stringify(receipt), { mode: 0o600 });
    await rename(temporary, path);
  }
  async status(id: string, key: string): Promise<CompactionReceipt | undefined> {
    let receipt: CompactionReceipt;
    try {
      receipt = JSON.parse(await readFile(this.path(id), "utf8")) as CompactionReceipt;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    if (receipt.operationId !== id || receipt.key !== key)
      throw new Error("Compaction identity conflict");
    if (receipt.state === "running" && receipt.bootId !== bootId) {
      receipt = { ...receipt, state: "interrupted" };
      await this.save(receipt);
    }
    return receipt;
  }
  async start(
    id: string,
    key: string,
    busy: () => boolean,
    compact: () => Promise<Record<string, unknown>>,
  ): Promise<CompactionReceipt> {
    // Serialize reservation and receipt creation only, never inference.
    const previous = this.serial;
    let release!: () => void;
    this.serial = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const existing = await this.status(id, key);
      if (existing) return existing;
      const receipt: CompactionReceipt = {
        operationId: id,
        key,
        bootId,
        state: this.busy(key) || busy() ? "skipped" : "running",
      };
      if (receipt.state === "skipped") receipt.result = { compacted: false, reason: "busy" };
      await this.save(receipt);
      if (receipt.state !== "running") return receipt;
      this.active.add(key);
      const task = (async () => {
        let final: CompactionReceipt;
        try {
          const result = await compact();
          const nested = result.result as
            | { sessionId?: string; details?: { pending?: boolean } }
            | undefined;
          // An acknowledgement, timeout, or lost native notification is not proof
          // of completion. Keep the gate until a terminal result or Gateway restart.
          if (nested?.details?.pending === true) return;
          final = {
            ...receipt,
            state:
              result.ok === false ? "failed" : result.compacted === true ? "completed" : "skipped",
            result: {
              compacted: result.compacted === true,
              ...(result.reason === "busy" ? { reason: "busy" } : {}),
              ...(nested?.sessionId ? { sessionId: nested.sessionId } : {}),
            },
          };
        } catch {
          final = { ...receipt, state: "failed" };
        }
        // A lost receipt must remain unresolved, never silently allow a repeat.
        await this.save(final);
        this.active.delete(key);
      })();
      this.tasks.add(task);
      void task.then(
        () => this.tasks.delete(task),
        () => {
          this.tasks.delete(task);
          console.error("Compaction receipt persistence failed");
        },
      );
      return receipt;
    } finally {
      release();
    }
  }
  async drain(): Promise<void> {
    await Promise.all(this.tasks);
  }
}
