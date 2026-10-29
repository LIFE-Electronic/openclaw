/** Exercise the patched native scheduler, sender and verifier with a fake provider. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  captureMediaIdentities,
  hasDeliveredGeneratedMedia,
  internalSendMediaIdentities,
  unmatchedGeneratedMedia,
} from "../../src/agents/generated-media-identity.ts";

const source = process.env.OPENCLAW_PATCHED_SOURCE;
async function native(file, name, dependencies) {
  const text = stripTypeScriptTypes(await readFile(path.join(source, file), "utf8"));
  const start = text.search(new RegExp(`function ${name}\\s*\\(`));
  assert.notEqual(start, -1, `${name} is missing from native source`);
  const end = text.indexOf("\n}", start) + 2;
  // Execute only repository-owned source extracted for this contract probe.
  // oxlint-disable-next-line typescript/no-implied-eval
  return new Function(
    ...Object.keys(dependencies),
    `return (${text.slice(start - (text.slice(start - 6, start) === "async " ? 6 : 0), end)});`,
  )(...Object.values(dependencies));
}

test(
  "native completion accepts a renamed copy and completes the task after a successful send",
  { skip: !source },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wolper-native-media-"));
    try {
      await mkdir(path.join(root, "media"));
      await mkdir(path.join(root, "workspace"));
      const original = path.join(root, "media/original.png");
      const copy = path.join(root, "workspace/renamed.png");
      await writeFile(original, "generated");
      const capture = (refs) => captureMediaIdentities(refs, root);
      const toolResult = await native(
        "src/infra/outbound/message-action-runner.ts",
        "buildInternalSourceReplyToolResult",
        {},
      );
      const sender = await native(
        "src/infra/outbound/message-action-runner.ts",
        "handleInternalSourceReplySendAction",
        {
          throwIfAborted: () => {},
          readBooleanParam: () => false,
          captureMediaIdentities: capture,
          buildSendPayloadParts: async () => ({
            payload: { mediaUrls: [copy] },
            mediaUrls: [copy],
          }),
          INTERNAL_MESSAGE_CHANNEL: "webchat",
          buildInternalSourceReplyToolResult: toolResult,
        },
      );
      const verifier = await native(
        "src/agents/subagent-announce-delivery.ts",
        "hasGatewayAgentMessagingToolDeliveredExpectedMedia",
        {
          getGatewayAgentResult: (response) => response,
          hasDeliveredGeneratedMedia,
        },
      );
      let captured;
      const wake = await native(
        "src/agents/tools/media-generate-background-shared.ts",
        "wakeMediaGenerationTaskCompletion",
        {
          captureMediaIdentities: capture,
          mediaUrlsFromGeneratedAttachments: (attachments) =>
            (attachments ?? []).map((a) => a.path),
          buildMediaGenerationReplyInstruction: () => "",
          formatAgentInternalEventsForPrompt: () => "",
          INTERNAL_MESSAGE_CHANNEL: "webchat",
          log: { info() {}, error() {} },
          deliverSubagentAnnouncement: async (params) => {
            const event = params.internalEvents[0];
            captured = event.mediaIdentities;
            assert.equal(
              captured.length,
              1,
              "expected bytes must be captured before the completion agent runs",
            );
            await writeFile(copy, await readFile(original));
            const sent = await sender(
              { agentId: "main", cfg: {}, sourceReplyDeliveryMode: "message_tool_only" },
              {},
            );
            const identities = internalSendMediaIdentities(sent.toolResult);
            assert.equal(identities.length, 1);
            // The agent may edit its copies after sending; receipts must stay stable.
            await writeFile(original, "later-original-edit");
            await writeFile(copy, "later-copy-edit");
            return {
              delivered: verifier(
                {
                  messagingToolSentMediaUrls: [copy],
                  messagingToolSentTargets: [{ mediaUrls: [copy], mediaIdentities: identities }],
                },
                [original],
                captured,
              ),
            };
          },
        },
      );
      const scheduler = await native(
        "src/agents/tools/media-generate-background-shared.ts",
        "scheduleMediaGenerationTaskCompletion",
        {
          withMediaGenerationTaskKeepalive: async ({ run }) => run(),
          formatErrorMessage: (error) => String(error),
        },
      );
      let state = "running";
      const pending = [];
      scheduler({
        handle: { taskId: "task", requesterSessionKey: "session", taskLabel: "image" },
        lifecycle: {
          recordTaskProgress() {},
          completeTaskRun() {
            state = "completed";
          },
          failTaskRun() {
            state = "failed";
          },
          wakeTaskCompletion: (params) =>
            wake({ ...params, toolName: "image_generate", completionLabel: "image" }),
        },
        scheduleBackgroundWork: (work) => pending.push(work),
        toolName: "Image generation",
        run: async () => ({
          provider: "fake",
          model: "fake",
          count: 1,
          paths: [original],
          mediaUrls: [original],
          attachments: [{ path: original }],
          wakeResult: "ready",
        }),
      });
      await pending[0]();
      assert.equal(state, "completed");
      const dry = await sender({ agentId: "main", cfg: {}, dryRun: true }, {});
      assert.deepEqual(internalSendMediaIdentities(dry.toolResult), []);
      assert.equal(verifier({ messagingToolSentMediaUrls: [copy] }, [original], captured), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "native fallback keeps an identical output that has no distinct successful send",
  { skip: !source },
  async () => {
    const fallback = await native(
      "src/agents/subagent-announce-delivery.ts",
      "resolveGeneratedMediaDirectFallbackUrls",
      {
        getGatewayAgentResult: (response) => response,
        hasDeliveredGeneratedMedia,
        unmatchedGeneratedMedia,
        uniqueStrings: (values) => [...new Set(values)],
        normalizeStringEntries: (values) => values,
      },
    );
    const first = "/home/node/.openclaw/media/tool-image-generation/first.png";
    const second = "/home/node/.openclaw/media/tool-image-generation/second.png";
    const copy = "/home/node/.openclaw/workspace/copy.png";
    const expected = [first, second].map((url) => ({ url, sha256: "a".repeat(64), size: 10 }));
    const receipt = {
      mediaReceiptId: "send-one",
      mediaUrls: [copy],
      mediaIdentities: [{ ...expected[0], url: copy }],
    };
    const evidence = { messagingToolSentMediaUrls: [copy], messagingToolSentTargets: [receipt] };
    assert.equal(hasDeliveredGeneratedMedia([first, second], expected, evidence), false);
    assert.deepEqual(
      fallback({
        expectedMediaUrls: [first, second],
        expectedIdentities: expected,
        announceResponse: evidence,
      }),
      [second],
    );
  },
);
