import { expect, it } from "vitest";
import { preserveBackgroundTranscriptIdentity } from "./wolper-background-identity.js";

it("restores only generated copy identifiers alongside redacted content", () => {
  const copyId = "e5c63330-a4e9-45b4-8856-6b5844245844";
  const runId = "62eeb4e7-16bb-4ad4-a49b-d32bff514886";
  const original = {
    role: "assistant",
    content: "secret",
    idempotencyKey: `wolper-copy:${copyId}`,
    __openclaw: { runId, copyId, origin: { trigger: "heartbeat" } },
  };
  const redacted = {
    ...original,
    content: "masked",
    idempotencyKey: "masked",
    __openclaw: { ...original["__openclaw"], copyId: "masked" },
  };
  expect(preserveBackgroundTranscriptIdentity(original, redacted)).toMatchObject({
    content: "masked",
    idempotencyKey: original.idempotencyKey,
    __openclaw: { runId, copyId },
  });
  expect(
    preserveBackgroundTranscriptIdentity(
      { ...original, __openclaw: { ...original["__openclaw"], copyId: "secret" } },
      redacted,
    ).idempotencyKey,
  ).toBe("masked");
});
