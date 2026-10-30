/** Match successful media sends by immutable byte identity when paths differ. */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type MediaIdentity = { url: string; sha256: string; size: number };
type RecordLike = Record<string, unknown>;

function record(value: unknown): RecordLike | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordLike)
    : undefined;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string" && !!v.trim())
    : [];
}

/** Normalize local URL spelling without fetching URLs or resolving new files. */
function reference(value: string): string {
  try {
    if (value.startsWith("file://")) {
      return path.normalize(fileURLToPath(value));
    }
    return path.isAbsolute(value) ? path.normalize(value) : value.trim();
  } catch {
    return value.trim();
  }
}

function identities(value: unknown): MediaIdentity[] {
  return Array.isArray(value)
    ? value.filter((item): item is MediaIdentity => {
        const v = record(item);
        return (
          !!v &&
          typeof v.url === "string" &&
          !!v.url.trim() &&
          typeof v.sha256 === "string" &&
          /^[a-f0-9]{64}$/.test(v.sha256) &&
          Number.isSafeInteger(v.size) &&
          (v.size as number) >= 0
        );
      })
    : [];
}

/** Snapshot only bounded regular files within the agent's media/workspace roots. */
export async function captureMediaIdentities(
  refs: readonly string[],
  stateRoot = process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), ".openclaw"),
  maxBytes = 64 * 1024 * 1024,
): Promise<MediaIdentity[]> {
  const result: MediaIdentity[] = [];
  const roots: string[] = [];
  for (const name of ["media", "workspace"]) {
    try {
      roots.push(await realpath(path.join(stateRoot, name)));
    } catch {
      /* Optional root. */
    }
  }
  for (const url of [...new Set(refs)].slice(0, 32)) {
    const local = reference(url);
    if (!path.isAbsolute(local)) {
      continue;
    }
    let handle;
    try {
      const resolved = await realpath(local);
      if (!roots.some((root) => resolved.startsWith(root + path.sep))) {
        continue;
      }
      handle = await open(
        resolved,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const before = await handle.stat();
      if (!before.isFile() || before.size > maxBytes) {
        continue;
      }
      const hash = createHash("sha256");
      const buffer = Buffer.alloc(64 * 1024);
      let size = 0;
      while (true) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (!bytesRead) {
          break;
        }
        size += bytesRead;
        if (size > maxBytes) {
          throw new Error("media identity byte limit");
        }
        hash.update(buffer.subarray(0, bytesRead));
      }
      const after = await handle.stat();
      if (
        size !== before.size ||
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs
      ) {
        throw new Error("media changed while capturing identity");
      }
      result.push({ url, sha256: hash.digest("hex"), size });
    } catch {
      // Missing/unreadable identities never prove delivery. Exact-path legacy
      // evidence remains available to the caller; do not fail generation here.
      console.warn("[media-completion] Could not capture a local attachment identity");
    } finally {
      await handle?.close();
    }
  }
  return result;
}

/** Only the runtime's committed internal UI send can contribute digest receipts. */
export function internalSendMediaIdentities(result: unknown): MediaIdentity[] {
  const details = record(record(result)?.details);
  if (
    !details ||
    details.status !== "ok" ||
    details.deliveryStatus !== "sent" ||
    details.sourceReplySink !== "internal-ui" ||
    details.dryRun === true
  ) {
    return [];
  }
  return identities(details.mediaIdentities);
}

/** Assign each successful send to at most one output, retaining unmatched URLs. */
export function unmatchedGeneratedMedia(
  expectedRefs: readonly string[],
  expectedIdentities: readonly MediaIdentity[],
  evidence: unknown,
): string[] {
  const result = record(evidence);
  const originals = new Map<string, string>();
  for (const ref of expectedRefs) {
    if (!originals.has(reference(ref))) {
      originals.set(reference(ref), ref.trim());
    }
  }
  const expected = [...originals.keys()];
  if (!expected.length) {
    return [];
  }
  if (
    !result ||
    ["failed", "partial_failed"].includes(String(record(result.deliveryStatus)?.status))
  ) {
    return [...originals.values()];
  }
  const sent: Array<{ url: string; identity?: MediaIdentity; identityRequired?: boolean }> = [];
  const targetUrls = new Set<string>();
  const seenReceipts = new Map<string, Set<string>>();
  const targets = Array.isArray(result.messagingToolSentTargets)
    ? result.messagingToolSentTargets
    : [];
  for (const [index, rawTarget] of targets.entries()) {
    const target = record(rawTarget);
    if (!target) {
      continue;
    }
    // A filename may be overwritten between successful calls. Keep each call's
    // immutable identities together instead of indexing all receipts by URL.
    const refs = [...new Set(strings(target.mediaUrls).map(reference))];
    const captured = new Map<string, MediaIdentity>();
    for (const identity of identities(target.mediaIdentities)) {
      const ref = reference(identity.url);
      if (refs.includes(ref)) {
        captured.set(ref, identity);
      }
    }
    const callId =
      typeof target.mediaReceiptId === "string" && target.mediaReceiptId.trim()
        ? `call:${target.mediaReceiptId}`
        : `legacy-target:${index}`;
    const observed = seenReceipts.get(callId) ?? new Set<string>();
    seenReceipts.set(callId, observed);
    for (const ref of refs) {
      targetUrls.add(ref);
      if (observed.has(ref)) {
        continue;
      }
      observed.add(ref);
      sent.push({
        url: ref,
        identity: captured.get(ref),
        identityRequired: target.mediaIdentityRequired === true,
      });
    }
  }
  // The flattened list mirrors target receipts. Add only legacy evidence that
  // has no target so one successful send cannot become two matching candidates.
  for (const ref of new Set(strings(result.messagingToolSentMediaUrls).map(reference))) {
    if (!targetUrls.has(ref)) {
      sent.push({ url: ref });
    }
  }
  const generated = new Map(expectedIdentities.map((item) => [reference(item.url), item]));
  const assignments = new Map<number, number>();
  const match = (expectedIndex: number, seen: Set<number>): boolean => {
    const ref = expected[expectedIndex];
    for (let index = 0; index < sent.length; index++) {
      if (seen.has(index)) {
        continue;
      }
      const a = generated.get(ref),
        b = sent[index].identity;
      const sameBytes = !!(a && b && a.sha256 === b.sha256 && a.size === b.size);
      // Pending final payloads have not committed a send: even the original
      // filename needs byte proof. Existing committed receipts keep their policy.
      if (sent[index].identityRequired ? !sameBytes : ref !== sent[index].url && !sameBytes) {
        continue;
      }
      seen.add(index);
      const previous = assignments.get(index);
      if (previous === undefined || match(previous, seen)) {
        assignments.set(index, expectedIndex);
        return true;
      }
    }
    return false;
  };
  // Do not stop at the first missing output: later outputs can still have a
  // successful receipt, and fallback must send only the unmatched remainder.
  expected.forEach((_, index) => match(index, new Set()));
  const matched = new Set(assignments.values());
  return expected.filter((_, index) => !matched.has(index)).map((ref) => originals.get(ref)!);
}

/** Completion and direct fallback consume exactly the same batch assignment. */
export function hasDeliveredGeneratedMedia(
  expectedRefs: readonly string[],
  expectedIdentities: readonly MediaIdentity[],
  evidence: unknown,
): boolean {
  return unmatchedGeneratedMedia(expectedRefs, expectedIdentities, evidence).length === 0;
}

/** Verify visible Webchat attachments; an external send or prose is not UI delivery. */
export async function hasDeliveredWebchatMedia(
  expectedRefs: readonly string[],
  expectedIdentities: readonly MediaIdentity[],
  evidence: unknown,
  stateRoot?: string,
): Promise<boolean> {
  const result = record(evidence);
  if (!result) {
    return false;
  }
  const targets = (
    Array.isArray(result.messagingToolSentTargets) ? result.messagingToolSentTargets : []
  ).filter((value) => record(value)?.provider === "webchat");
  const observed = new Set(
    targets.flatMap((value) => strings(record(value)?.mediaUrls).map(reference)),
  );
  const payloads = Array.isArray(result.payloads) ? result.payloads : [];
  // Capture final reply files at the handoff boundary. Keep one receipt per
  // payload so one attachment cannot satisfy multiple identical outputs.
  for (const [index, value] of payloads.entries()) {
    const payload = record(value);
    if (!payload || payload.isError === true || payload.isReasoning === true) {
      continue;
    }
    const refs = [
      ...new Set([
        ...(typeof payload.mediaUrl === "string" ? [payload.mediaUrl] : []),
        ...strings(payload.mediaUrls),
      ]),
    ].filter((ref) => !observed.has(reference(ref)));
    // Source-reply payloads can mirror tool receipts. Count the attachment once.
    for (const ref of refs) {
      observed.add(reference(ref));
    }
    if (!refs.length) {
      continue;
    }
    const captured = await captureMediaIdentities(refs, stateRoot);
    const available = new Set(captured.map((item) => reference(item.url)));
    const finalRefs = refs.filter((ref) => available.has(reference(ref)));
    if (!finalRefs.length) {
      continue;
    }
    targets.push({
      provider: "webchat",
      mediaReceiptId: `webchat-final:${index}`,
      // Local-only receipt metadata prevents the shared batch matcher from
      // accepting a deleted or overwritten final attachment by filename alone.
      mediaIdentityRequired: true,
      mediaUrls: finalRefs,
      mediaIdentities: captured,
    });
  }
  const delivered = hasDeliveredGeneratedMedia(expectedRefs, expectedIdentities, {
    deliveryStatus: result.deliveryStatus,
    messagingToolSentTargets: targets,
  });
  if (!delivered && payloads.length) {
    console.warn(
      "[media-completion] Final Webchat attachments did not prove generated-media delivery",
    );
  }
  return delivered;
}
