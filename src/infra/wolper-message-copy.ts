/** Durable receipts make native session copies safe to retry after a lost connection. */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { writeJsonDurableQueueEntry } from "@openclaw/fs-safe/store";
import { z } from "zod";
import { acquireSessionWriteLock } from "../agents/session-write-lock.js";

const messageSchema = z
  .object({
    role: z.literal("assistant"),
    content: z.union([z.string(), z.array(z.record(z.string(), z.unknown()))]),
  })
  .passthrough();
export const copyRequestSchema = z
  .object({
    copyId: z.uuid(),
    executionId: z.string().min(1).max(200),
    destinationSessionKey: z
      .string()
      .regex(/^agent:[A-Za-z0-9_-]+:[^\s]+$/u)
      .max(500),
    origin: z
      .object({
        trigger: z.enum(["cron", "heartbeat"]),
        is_heartbeat: z.boolean(),
        cron_job_id: z.string().nullable(),
        cron_job_name: z.string().nullable().optional(),
      })
      .strict(),
    message: messageSchema,
  })
  .strict();
export type CopyRequest = z.infer<typeof copyRequestSchema>;
const committedCopySchema = z.object({
  status: z.literal("committed"),
  copyId: z.uuid(),
  executionId: z.string(),
  destinationSessionKey: z.string(),
  sessionId: z.string(),
  messageId: z.string(),
  message: messageSchema,
});
export type CommittedCopy = z.infer<typeof committedCopySchema>;
export type CopyResult = CommittedCopy | { status: "busy"; copyId: string };
export type CopyDependencies = {
  stateDir: string;
  resolveSession: (
    request: CopyRequest,
    expectedSessionId?: string,
  ) => Promise<{ sessionId: string; busy: boolean }>;
  append: (
    request: CopyRequest,
    sessionId: string,
  ) => Promise<{ messageId: string; message: z.infer<typeof messageSchema> }>;
};
const recordSchema = z.object({
  digest: z.string(),
  sessionId: z.string(),
  receipt: committedCopySchema.optional(),
});
export class CopyBusyError extends Error {}
export class CopyConflictError extends Error {}

function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export async function copyMessage(input: CopyRequest, deps: CopyDependencies): Promise<CopyResult> {
  const request = copyRequestSchema.parse(input);
  const digest = createHash("sha256").update(canonical(request)).digest("hex");
  const directory = path.join(deps.stateDir, "wolper-message-copies");
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const filePath = path.join(directory, `${request.copyId}.json`);
  // A separate per-copy lock covers both transcript append and receipt commit.
  const lock = await acquireSessionWriteLock({ sessionFile: filePath });
  try {
    let saved: z.infer<typeof recordSchema> | undefined;
    try {
      saved = recordSchema.parse(JSON.parse(await fs.readFile(filePath, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    if (saved && saved.digest !== digest) {
      throw new CopyConflictError("Native copy identity conflict");
    }
    const target = await deps.resolveSession(request, saved?.sessionId);
    if (saved && saved.sessionId !== target.sessionId) {
      throw new CopyConflictError("Native copy session changed");
    }
    if (saved?.receipt) {
      return saved.receipt;
    }
    if (target.busy) {
      return { status: "busy", copyId: request.copyId };
    }
    // Persist the session epoch before append. A reset must not receive an old retry.
    if (!saved) {
      await writeJsonDurableQueueEntry({
        filePath,
        entry: { digest, sessionId: target.sessionId },
        tempPrefix: ".wolper-copy",
      });
    }
    let appended: Awaited<ReturnType<CopyDependencies["append"]>>;
    try {
      appended = await deps.append(request, target.sessionId);
    } catch (error) {
      if (error instanceof CopyBusyError) {
        return { status: "busy", copyId: request.copyId };
      }
      throw error;
    }
    const receipt = committedCopySchema.parse({
      status: "committed",
      copyId: request.copyId,
      executionId: request.executionId,
      destinationSessionKey: request.destinationSessionKey,
      sessionId: target.sessionId,
      ...appended,
    });
    await writeJsonDurableQueueEntry({
      filePath,
      entry: { digest, sessionId: target.sessionId, receipt },
      tempPrefix: ".wolper-copy",
    });
    return receipt;
  } finally {
    await lock.release();
  }
}
