import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";
import {
  captureMediaIdentities,
  hasDeliveredGeneratedMedia,
  internalSendMediaIdentities,
  unmatchedGeneratedMedia,
} from "../../src/agents/generated-media-identity.ts";

const root = await mkdtemp(path.join(os.tmpdir(), "wolper-media-identity-"));
after(() => rm(root, { recursive: true, force: true }));
await mkdir(path.join(root, "media"), { recursive: true });
await mkdir(path.join(root, "workspace"), { recursive: true });
const original = path.join(root, "media/generated.png");
const copy = path.join(root, "workspace/renamed.png");
const other = path.join(root, "workspace/other.png");
await writeFile(original, "generated-image");
await writeFile(copy, "generated-image");
await writeFile(other, "different-image");
const sha256 = createHash("sha256").update("generated-image").digest("hex");
const expected = await captureMediaIdentities([original], root);
const sent = await captureMediaIdentities([copy], root);
const different = await captureMediaIdentities([other], root);

function delivered(urls, identities = []) {
  return {
    messagingToolSentMediaUrls: urls,
    messagingToolSentTargets: [
      { tool: "message", provider: "webchat", mediaUrls: urls, mediaIdentities: identities },
    ],
  };
}

test("recognizes the original path and an identical renamed copy", () => {
  assert.deepEqual(expected, [{ url: original, sha256, size: 15 }]);
  assert.equal(hasDeliveredGeneratedMedia([original], expected, delivered([original])), true);
  assert.equal(hasDeliveredGeneratedMedia([original], expected, delivered([copy], sent)), true);
  assert.equal(
    hasDeliveredGeneratedMedia([original], expected, delivered([pathToFileURL(original).href])),
    true,
  );
});

test("rejects different content, an unrelated send, and final payloads without a send", () => {
  assert.equal(
    hasDeliveredGeneratedMedia([original], expected, delivered([other], different)),
    false,
  );
  assert.equal(hasDeliveredGeneratedMedia([original], expected, delivered([], sent)), false);
  assert.equal(
    hasDeliveredGeneratedMedia([original], expected, { payloads: [{ mediaUrls: [original] }] }),
    false,
  );
  assert.equal(
    hasDeliveredGeneratedMedia([original], expected, { messagingToolSentTexts: ["done"] }),
    false,
  );
});

test("requires a distinct delivered attachment for every generated output", () => {
  const second = path.join(root, "media/second.png");
  const both = [...expected, { ...expected[0], url: second }];
  assert.equal(
    hasDeliveredGeneratedMedia([original, second], both, delivered([copy], sent)),
    false,
  );
  assert.equal(
    hasDeliveredGeneratedMedia(
      [original, other],
      [...expected, ...different],
      delivered([copy], sent),
    ),
    false,
  );
  assert.equal(
    hasDeliveredGeneratedMedia(
      [original, other],
      [...expected, ...different],
      delivered([copy, other], [...sent, ...different]),
    ),
    true,
  );
});

test("preserves distinct immutable receipts when successive sends reuse one path", () => {
  const targets = [
    {
      mediaReceiptId: "send-one",
      mediaUrls: [copy],
      mediaIdentities: [{ ...expected[0], url: copy }],
    },
    {
      mediaReceiptId: "send-two",
      mediaUrls: [copy],
      mediaIdentities: [{ ...different[0], url: copy }],
    },
  ];
  const evidence = { messagingToolSentMediaUrls: [copy, copy], messagingToolSentTargets: targets };
  assert.equal(
    hasDeliveredGeneratedMedia([original, other], [...expected, ...different], evidence),
    true,
  );
  // The older receipt must still prove the first image after the same filename
  // has been overwritten and sent again with the second image's bytes.
  assert.equal(hasDeliveredGeneratedMedia([original], expected, evidence), true);
  const second = path.join(root, "media/identical-second.png");
  const duplicates = [...expected, { ...expected[0], url: second }];
  const sameBytes = targets.map((target) =>
    Object.assign({}, target, {
      mediaIdentities: [{ ...expected[0], url: copy }],
    }),
  );
  assert.equal(
    hasDeliveredGeneratedMedia([original, second], duplicates, {
      messagingToolSentTargets: sameBytes,
    }),
    true,
  );
  // A duplicated observation of a single tool call is still only one send.
  assert.equal(
    hasDeliveredGeneratedMedia([original, second], duplicates, {
      messagingToolSentTargets: [sameBytes[0], { ...sameBytes[0] }],
    }),
    false,
  );
});

test("fallback derives all unmatched outputs from one batch-wide assignment", () => {
  const second = path.join(root, "media/identical-second.png");
  const both = [...expected, { ...expected[0], url: second }];
  const evidence = delivered([copy], sent);
  assert.deepEqual(unmatchedGeneratedMedia([original, second], both, evidence), [second]);
  assert.deepEqual(
    unmatchedGeneratedMedia([other, original], [...different, ...expected], evidence),
    [other],
  );
  assert.deepEqual(unmatchedGeneratedMedia([original, second], both, null), [original, second]);
  assert.equal(hasDeliveredGeneratedMedia([original, second], both, evidence), false);
  assert.deepEqual(
    unmatchedGeneratedMedia([original, second], both, {
      messagingToolSentTargets: [
        { mediaReceiptId: "first", mediaUrls: [copy], mediaIdentities: sent },
        {
          mediaReceiptId: "fallback",
          mediaUrls: [second],
          mediaIdentities: [{ ...expected[0], url: second }],
        },
      ],
    }),
    [],
  );
});

test("uses captured bytes even if the files change after generation or send", async () => {
  await writeFile(copy, "changed-after-send");
  assert.equal(hasDeliveredGeneratedMedia([original], expected, delivered([copy], sent)), true);
  const changedSend = await captureMediaIdentities([copy], root);
  assert.equal(
    hasDeliveredGeneratedMedia([original], expected, delivered([copy], changedSend)),
    false,
  );
});

test("only accepts identity receipts from successful internal UI sends", () => {
  const details = {
    status: "ok",
    deliveryStatus: "sent",
    sourceReplySink: "internal-ui",
    mediaIdentities: sent,
  };
  assert.deepEqual(internalSendMediaIdentities({ details }), sent);
  for (const patch of [
    { dryRun: true },
    { deliveryStatus: "dry_run" },
    { deliveryStatus: "failed" },
    { sourceReplySink: "external" },
    { status: "error" },
  ]) {
    assert.deepEqual(internalSendMediaIdentities({ details: { ...details, ...patch } }), []);
  }
  assert.deepEqual(
    internalSendMediaIdentities({
      details: { ...details, mediaIdentities: [{ url: copy, sha256: "invalid", size: 15 }] },
    }),
    [],
  );
});

test("bounds hashing and refuses missing files, secrets, remote URLs and escaping symlinks", async () => {
  const outside = path.join(root, "secret.txt");
  await writeFile(outside, "private");
  const link = path.join(root, "workspace/escape.png");
  await symlink(outside, link);
  assert.deepEqual(
    await captureMediaIdentities(
      [outside, link, "https://example.com/image.png", path.join(root, "workspace/missing")],
      root,
    ),
    [],
  );
  assert.deepEqual(await captureMediaIdentities([original], root, 3), []);
});
