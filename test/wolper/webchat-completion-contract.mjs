/** Shared regression contract for staged source and installed compiled runtime. */
import assert from "node:assert/strict";
import {
  readFile as readFixture,
  writeFile as writeFixture,
  unlink as removeFixture,
} from "node:fs/promises";

export async function verifyWebchatCompletion(native, identity, original, copy) {
  const announceFile = "src/agents/subagent-announce-delivery.ts";
  const mediaFile = "src/agents/tools/media-generate-background-shared.ts";
  const normalize = (value) => value?.trim().toLowerCase();
  const isMedia = (value) => ["image_generate", "video_generate", "music_generate"].includes(value);
  const common = {
    INTERNAL_MESSAGE_CHANNEL: "webchat",
    isInternalMessageChannel: (value) => normalize(value) === "webchat",
    normalizeMessageChannel: normalize,
    normalizeOptionalLowercaseString: normalize,
    normalizeDeliveryContext: (value) => value,
    isAgentMediatedCompletionSourceTool: isMedia,
    getGatewayAgentResult: (response) => response?.result ?? response,
    ...identity,
  };
  const instruction = await native(mediaFile, "buildMediaGenerationReplyInstruction", {
    ...common,
    SILENT_REPLY_TOKEN: "NO_REPLY",
  });
  for (const status of ["ok", "error"]) {
    const internal = instruction({
      status,
      completionLabel: "image",
      requesterOrigin: { channel: "webchat" },
    });
    assert.match(internal, /final reply/i);
    assert.doesNotMatch(internal, /requires message-tool|user will NOT see/i);
    if (status === "ok") {
      assert.match(internal, /MEDIA:/);
    }
    assert.match(
      instruction({
        status,
        completionLabel: "image",
        requesterOrigin: { channel: "telegram", to: "123" },
      }),
      /requires message-tool/i,
    );
  }

  const expected = await verifyWebchatMediaEvidence(identity, original, copy);

  const webchatRoute = await native(announceFile, "isWebchatMediaCompletion", common);
  const routed = {
    expectsCompletionMessage: true,
    sourceTool: "image_generate",
    completionDirectOrigin: { channel: "webchat" },
  };
  assert.equal(webchatRoute(routed), true);
  assert.equal(webchatRoute({ ...routed, sourceTool: "subagent_announce" }), false);
  assert.equal(
    webchatRoute({
      ...routed,
      completionDirectOrigin: { channel: "telegram" },
      requesterSessionOrigin: { channel: "webchat" },
    }),
    false,
  );
  const valid = { payloads: [{ text: "Here it is.", mediaUrl: copy }] };
  const sent = [];
  let response = { result: valid };
  let active = false;
  let damageFinalFile;
  const deps = {
    ...common,
    isWebchatMediaCompletion: webchatRoute,
    subagentAnnounceDeliveryDeps: {
      getRuntimeConfig: () => ({}),
      isRequesterSessionAbandoned: () => false,
    },
    resolveSubagentAnnounceTimeoutMs: () => 1000,
    resolveRequesterStoreKey: (_, key) => key,
    mergeDeliveryContext: (first, fallback) => ({ ...fallback, ...first }),
    stripNonDeliverableChannelForCompletionOrigin: (origin) =>
      origin?.channel === "webchat" ? undefined : origin,
    loadRequesterSessionEntry: () => ({ entry: {} }),
    resolveExternalBestEffortDeliveryTarget: (origin) =>
      origin.channel && origin.channel !== "webchat"
        ? { ...origin, deliver: true }
        : { deliver: false },
    isGatewayMessageChannel: () => true,
    requiresAgentMediatedCompletionDelivery: (p) =>
      p.expectsCompletionMessage && isMedia(p.sourceTool),
    collectExpectedMediaFromInternalEvents: (events) =>
      events?.flatMap((event) => event.mediaUrls ?? []) ?? [],
    // Even inherited message-tool-only settings must not suppress the Webchat reply.
    completionRequiresMessageToolDelivery: () => true,
    isDirectMessageDeliveryTarget: () => true,
    resolveRequesterSessionActivity: () => ({ sessionId: "session", isActive: active }),
    resolveQueueSettings: () => ({}),
    resolveActiveWakeWithRetries: () => {
      throw new Error("Queuing is not verified media delivery");
    },
    isCronRunSessionKey: () => false,
    stringifyRouteThreadId: (value) => value,
    runAnnounceDeliveryWithRetry: (p) => p.run(),
    runAnnounceAgentCall: async (p) => {
      sent.push(p.agentParams);
      // Simulate a completion agent damaging the original after generation's
      // identity snapshot and before its final payload reaches verification.
      if (damageFinalFile === "deleted") {
        await removeFixture(original);
      }
      if (damageFinalFile === "overwritten") {
        const changed = Buffer.from(await readFixture(original));
        changed[0] ^= 0xff;
        await writeFixture(original, changed);
      }
      return response;
    },
    isGatewayAgentRunPending: (result) => result.status === "accepted",
    getGatewayAgentCommandDeliveryFailure: (result) =>
      result.result?.deliveryStatus?.status === "failed" ? "failed" : undefined,
    hasGatewayAgentMessagingToolDeliveredExpectedMedia: (result, refs, identities) =>
      identity.hasDeliveredGeneratedMedia(refs, identities, result.result),
    hasGatewayAgentDeliveredExpectedMedia: () => false,
    resolveGeneratedMediaDirectFallbackUrls: (p) => p.expectedMediaUrls,
    deliverGeneratedMediaCompletionDirect: async () => undefined,
    hasVisibleGatewayAgentPayload: (result) =>
      !!result.result?.payloads?.some((p) => p.text || p.mediaUrl),
    hasGatewayAgentMessagingToolDeliveryEvidence: (result) =>
      !!result.result?.messagingToolSentTargets?.length,
    hasIntentionalSilentGatewayAgentPayload: () => false,
    hasFailedSubagentNoOutputCompletion: () => false,
    isPermanentAnnounceDeliveryError: () => false,
    summarizeDeliveryError: (error) => String(error),
    defaultRuntime: { log() {} },
  };
  const send = await native(announceFile, "sendSubagentAnnounceDirectly", deps);
  const params = {
    ...routed,
    requesterSessionKey: "agent:main:main",
    targetRequesterSessionKey: "agent:main:main",
    requesterIsSubagent: false,
    triggerMessage: "ready",
    directIdempotencyKey: "completion",
    directOrigin: { channel: "telegram", to: "stale-target" },
    requesterSessionOrigin: { channel: "telegram", to: "stale-target" },
    internalEvents: [{ status: "ok", mediaUrls: [original], mediaIdentities: expected }],
  };
  for (const tool of ["image_generate", "video_generate", "music_generate"]) {
    for (const busy of [false, true]) {
      active = busy;
      assert.equal((await send({ ...params, sourceTool: tool })).delivered, true);
      const actual = sent.at(-1);
      assert.equal(actual.sourceReplyDeliveryMode, "automatic");
      assert.equal(actual.channel, "webchat");
      assert.equal(actual.deliver, false);
      assert.equal(actual.to, undefined);
      assert.deepEqual(actual.internalEvents[0].mediaUrls, [original]);
      assert.equal(
        actual.internalEvents[0].mediaIdentities,
        undefined,
        "private verifier metadata must not cross the strict Gateway agent RPC schema",
      );
    }
  }
  active = false;
  for (const bad of [
    { status: "accepted" },
    { result: { payloads: [{ text: "Done" }] } },
    { result: { ...valid, deliveryStatus: { status: "failed" } } },
  ]) {
    response = bad;
    assert.equal((await send(params)).delivered, false);
  }
  response = {
    result: { messagingToolSentTargets: [{ provider: "telegram", mediaUrls: [original] }] },
  };
  assert.equal(
    (await send({ ...params, completionDirectOrigin: { channel: "telegram", to: "123" } }))
      .delivered,
    true,
  );
  assert.equal(sent.at(-1).sourceReplyDeliveryMode, "message_tool_only");
  assert.equal(sent.at(-1).channel, "telegram");
  assert.equal(sent.at(-1).to, "123");
  response = { result: valid };
  assert.equal(
    (await send({ ...params, completionDirectOrigin: { channel: "telegram", to: "123" } }))
      .delivered,
    false,
    "An external route still requires a successful messaging receipt",
  );

  // Dispatch must not turn a failed verified handoff into success by merely queuing it.
  const dispatch = await native(announceFile, "deliverSubagentAnnouncement", {
    ...common,
    isWebchatMediaCompletion: webchatRoute,
    runSubagentAnnounceDispatch: async (p) => {
      const direct = await p.direct();
      assert.equal((await p.steer()).status, "none");
      return direct;
    },
    sendSubagentAnnounceDirectly: async () => ({ delivered: false, path: "direct" }),
    maybeSteerSubagentAnnounce: () => {
      throw new Error("Must not accept unverified steering");
    },
  });
  assert.equal((await dispatch(params)).delivered, false);

  // Exercise the real scheduler -> wake -> announce path with a fake provider.
  const wake = await native(mediaFile, "wakeMediaGenerationTaskCompletion", {
    ...common,
    buildMediaGenerationReplyInstruction: instruction,
    mediaUrlsFromGeneratedAttachments: (items) => (items ?? []).map((item) => item.path),
    formatAgentInternalEventsForPrompt: (events) => events[0].replyInstruction,
    log: { info() {}, error() {} },
    tryDeliverMediaGenerationFailureDirect: async () => false,
    deliverSubagentAnnouncement: async (p) => {
      assert.match(p.triggerMessage, /normal visible assistant final reply/i);
      assert.equal(p.internalEvents[0].replyInstruction.includes("requires message-tool"), false);
      return send(p);
    },
  });
  const scheduler = await native(mediaFile, "scheduleMediaGenerationTaskCompletion", {
    withMediaGenerationTaskKeepalive: (p) => p.run(),
    formatErrorMessage: String,
  });
  const savedOriginal = await readFixture(original);
  for (const scenario of ["visible", "missing", "deleted", "overwritten"]) {
    damageFinalFile = ["deleted", "overwritten"].includes(scenario) ? scenario : undefined;
    response = {
      result:
        scenario === "visible"
          ? valid
          : scenario === "missing"
            ? { payloads: [{ text: "Done" }] }
            : { payloads: [{ mediaUrl: original }] },
    };
    let state = "running";
    const pending = [];
    scheduler({
      handle: {
        taskId: "fake-media",
        runId: "fake-run",
        requesterSessionKey: "agent:main:main",
        requesterOrigin: { channel: "webchat" },
        taskLabel: "image",
      },
      lifecycle: {
        recordTaskProgress() {},
        completeTaskRun() {
          state = "completed";
        },
        failTaskRun() {
          state = "failed";
        },
        wakeTaskCompletion: (p) =>
          wake({ ...p, toolName: "image_generate", completionLabel: "image" }),
      },
      scheduleBackgroundWork: (work) => pending.push(work),
      toolName: "Image generation",
      onWakeFailure() {},
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
    try {
      await pending[0]();
      assert.equal(
        state,
        scenario === "visible" ? "completed" : "failed",
        `Scheduler must not complete a ${scenario} final attachment`,
      );
    } finally {
      await writeFixture(original, savedOriginal);
    }
  }
  return {
    webchatCompletion: true,
    requesterRoute: true,
    externalDelivery: true,
    verifiedCompletion: true,
    finalAttachmentIntegrity: true,
  };
}

/** This evidence contract also runs in CI without an upstream source checkout. */
export async function verifyWebchatMediaEvidence(identity, original, copy) {
  const expected = await identity.captureMediaIdentities([original]);
  assert.equal(expected.length, 1);
  const valid = { payloads: [{ text: "Here it is.", mediaUrl: copy }] };
  assert.equal(await identity.hasDeliveredWebchatMedia([original], expected, valid), true);
  for (const result of [
    { payloads: [{ text: `Here it is: ${original}` }] },
    { payloads: [{ mediaUrl: copy, isError: true }] },
    { payloads: [{ mediaUrl: copy, isReasoning: true }] },
    { ...valid, deliveryStatus: { status: "failed" } },
    { messagingToolSentTargets: [{ provider: "telegram", mediaUrls: [original] }] },
  ]) {
    assert.equal(await identity.hasDeliveredWebchatMedia([original], expected, result), false);
  }
  assert.equal(
    await identity.hasDeliveredWebchatMedia([original, original + ".second"], expected, valid),
    false,
  );
  assert.equal(
    await identity.hasDeliveredWebchatMedia([original], expected, {
      messagingToolSentTargets: [
        { provider: "webchat", mediaReceiptId: "send", mediaUrls: [original] },
      ],
    }),
    true,
  );
  assert.equal(
    await identity.hasDeliveredWebchatMedia(
      [original, original + ".second"],
      [...expected, { ...expected[0], url: original + ".second" }],
      {
        payloads: [{ mediaUrl: copy }],
        messagingToolSentTargets: [
          {
            provider: "webchat",
            mediaReceiptId: "send",
            mediaUrls: [copy],
            mediaIdentities: [{ ...expected[0], url: copy }],
          },
        ],
      },
    ),
    false,
    "The final payload may mirror a tool send; observing it twice is not two deliveries",
  );

  await verifyWebchatFinalAttachmentIntegrity(identity, original, copy);

  return expected;
}

/** A final reply is pending delivery, so its current bytes must prove generation. */
export async function verifyWebchatFinalAttachmentIntegrity(identity, original, copy) {
  const originalBytes = await readFixture(original);
  const copyBytes = await readFixture(copy);
  const expected = await identity.captureMediaIdentities([original]);
  const final = (ref) => ({ payloads: [{ mediaUrl: ref }] });
  const committed = {
    messagingToolSentTargets: [
      { provider: "webchat", mediaReceiptId: "already-sent", mediaUrls: [original] },
    ],
  };
  try {
    assert.equal(
      await identity.hasDeliveredWebchatMedia([original], expected, final(original)),
      true,
    );
    for (const ref of [original, copy]) {
      const saved = ref === original ? originalBytes : copyBytes;
      await removeFixture(ref);
      assert.equal(
        await identity.hasDeliveredWebchatMedia([original], expected, final(ref)),
        false,
        "A deleted final attachment must not count as delivered",
      );
      if (ref === original) {
        assert.equal(
          await identity.hasDeliveredWebchatMedia([original], expected, committed),
          true,
          "A committed exact-path send remains valid after local cleanup",
        );
      }
      const replacement = Buffer.from(saved);
      replacement[0] ^= 0xff;
      await writeFixture(ref, replacement);
      assert.equal(
        await identity.hasDeliveredWebchatMedia([original], expected, final(ref)),
        false,
        "A same-size overwrite must not count as delivery of the generated bytes",
      );
      await writeFixture(ref, saved);
    }
    assert.equal(
      await identity.hasDeliveredWebchatMedia([original], [], final(original)),
      false,
      "A pending final reply needs generation identity; a filename alone is not proof",
    );
    assert.equal(
      await identity.hasDeliveredWebchatMedia([original], [], committed),
      true,
      "Existing committed sends retain path-only compatibility",
    );
  } finally {
    await writeFixture(original, originalBytes);
    await writeFixture(copy, copyBytes);
  }
}
