/** Keep generated routing identities opaque while all message content is redacted. */
function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function preserveBackgroundTranscriptIdentity<T>(original: T, redacted: T): T {
  const before = record(original);
  const after = record(redacted);
  const native = record(before?.["__openclaw"]);
  const origin = record(native?.origin);
  const runId = native?.runId;
  if (
    before?.role !== "assistant" ||
    !after ||
    !native ||
    !["cron", "heartbeat"].includes(String(origin?.trigger)) ||
    typeof runId !== "string"
  ) {
    return redacted;
  }
  // Only scheduler-generated identities qualify. In particular an arbitrary
  // Telegram token in a user/tool field must still pass through the redactor.
  const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
  if (
    !new RegExp(
      `^(?:${uuid}|cron:${uuid}:[0-9]{1,16}:${uuid}|manual:${uuid}:[0-9]{1,16}:[0-9]+)$`,
      "i",
    ).test(runId)
  ) {
    return redacted;
  }
  // Timestamp:UUID looks like a bot token to the generic content scrubber.
  // Restoring only these protocol fields keeps append/scan retries idempotent
  // and companion/final execution correlation intact, without revealing text.
  const copyId = native.copyId;
  const copyIdentity =
    typeof copyId === "string" &&
    new RegExp(`^${uuid}$`, "i").test(copyId) &&
    before.idempotencyKey === `wolper-copy:${copyId}`;
  return {
    ...after,
    __openclaw: { ...record(after["__openclaw"]), runId, ...(copyIdentity ? { copyId } : {}) },
    ...(before.idempotencyKey === `wolper-background:${runId}` || copyIdentity
      ? { idempotencyKey: before.idempotencyKey }
      : {}),
  } as T;
}
