/** Exercise native completion routing with a fake provider and real local media. */
import { readFile, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import * as identity from "../../src/agents/generated-media-identity.ts";
import {
  verifyWebchatCompletion,
  verifyWebchatMediaEvidence,
} from "./webchat-completion-contract.mjs";

const source = process.env.OPENCLAW_PATCHED_SOURCE;
test(
  "native media completion follows its requester route and verifies delivery",
  { skip: !source },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wolper-webchat-media-"));
    try {
      await mkdir(path.join(root, "media"));
      await mkdir(path.join(root, "workspace"));
      const original = path.join(root, "media/generated.png");
      const copy = path.join(root, "workspace/copy.png");
      await writeFile(original, "fake-provider-image");
      await writeFile(copy, "fake-provider-image");
      const native = async (file, name, dependencies) => {
        const text = stripTypeScriptTypes(await readFile(path.join(source, file), "utf8"));
        const start = text.search(new RegExp(`function ${name}\\s*\\(`));
        if (start < 0) {
          throw new Error(`Missing native function: ${name}`);
        }
        const end = text.indexOf("\n}", start) + 2;
        // Execute only repository-owned source extracted for this contract probe.
        // oxlint-disable-next-line typescript/no-implied-eval
        return new Function(
          ...Object.keys(dependencies),
          `return (${text.slice(text.slice(start - 6, start) === "async " ? start - 6 : start, end)});`,
        )(...Object.values(dependencies));
      };
      await verifyWebchatCompletion(
        native,
        {
          ...identity,
          captureMediaIdentities: (refs) => identity.captureMediaIdentities(refs, root),
          hasDeliveredWebchatMedia: (...args) => identity.hasDeliveredWebchatMedia(...args, root),
        },
        original,
        copy,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

// Run the attachment verifier in CI even when the pinned upstream tree is absent.
test("Webchat evidence rejects missing, external and duplicate attachment observations", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wolper-webchat-proof-"));
  try {
    await mkdir(path.join(root, "media"));
    await mkdir(path.join(root, "workspace"));
    const original = path.join(root, "media/generated.png");
    const copy = path.join(root, "workspace/copy.png");
    await writeFile(original, "fake-provider-image");
    await writeFile(copy, "fake-provider-image");
    await verifyWebchatMediaEvidence(
      {
        ...identity,
        captureMediaIdentities: (refs) => identity.captureMediaIdentities(refs, root),
        hasDeliveredWebchatMedia: (...args) => identity.hasDeliveredWebchatMedia(...args, root),
      },
      original,
      copy,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
