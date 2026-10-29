import {
  createPluginRuntimeMock,
  createStartAccountContext,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { createReplyDispatcher } from "openclaw/plugin-sdk/reply-runtime";
import { describe, expect, it, vi } from "vitest";
import { createQaBusState, startQaBusServer } from "../../qa-lab/bus-api.js";
import { getQaBusState, injectQaBusInboundMessage } from "./bus-client.js";
import { startQaGatewayAccount } from "./gateway.js";
import { handleQaInbound } from "./inbound.js";
import { createQaInboundParams, runQaInbound } from "./inbound.test-harness.js";

type QaDispatch = ReturnType<typeof createPluginRuntimeMock>["channel"]["inbound"]["dispatch"];

function acceptedDispatch(
  turn: Parameters<QaDispatch>[0],
  deferredToActiveRun?: "steer" | "followup",
): Awaited<ReturnType<QaDispatch>> {
  return {
    admission: { kind: "dispatch" },
    dispatched: true,
    ctxPayload: turn.ctxPayload,
    routeSessionKey: turn.route.sessionKey,
    dispatchResult: {
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
      deferredToActiveRun,
    },
  };
}

function startGateway(
  params: ReturnType<typeof createQaInboundParams>,
  runtime: ReturnType<typeof createPluginRuntimeMock>,
  controller: AbortController,
) {
  return startQaGatewayAccount(params.channelId, params.channelLabel, {
    ...createStartAccountContext({
      account: params.account,
      cfg: params.config,
      abortSignal: controller.signal,
    }),
    channelRuntime: runtime.channel,
  });
}

async function withQaBus(
  run: (
    params: ReturnType<typeof createQaInboundParams>,
    state: ReturnType<typeof createQaBusState>,
  ) => Promise<void>,
) {
  const state = createQaBusState();
  const bus = await startQaBusServer({ state });
  try {
    const params = createQaInboundParams();
    params.account.baseUrl = bus.baseUrl;
    params.config = { channels: { "qa-channel": { baseUrl: bus.baseUrl } } };
    params.message = (
      await injectQaBusInboundMessage({
        baseUrl: bus.baseUrl,
        input: params.message,
      })
    ).message;
    await run(params, state);
  } finally {
    await bus.stop();
  }
}

async function visibleReplies(baseUrl: string) {
  const state = await getQaBusState(baseUrl);
  return state.messages.filter((message) => message.direction === "outbound" && !message.deleted);
}

describe("QA inbound dispatch settlement", () => {
  it.each([false, true])(
    "admits the next input while followup delivery is pending (failed=%s)",
    async (failed) => {
      await withQaBus(async (params, state) => {
        params.config.messages = { queue: { mode: "collect" } };
        const runtime = createPluginRuntimeMock();
        const first =
          Promise.withResolvers<Parameters<typeof runtime.channel.inbound.dispatch>[0]>();
        const dispatch = vi.mocked(runtime.channel.inbound.dispatch);
        dispatch.mockImplementationOnce(async (turn) => {
          await turn.replyOptions?.onPartialReply?.({ text: "queued preview" });
          first.resolve(turn);
          return acceptedDispatch(turn, "followup");
        });
        dispatch.mockImplementationOnce(async (turn) => acceptedDispatch(turn));
        const controller = new AbortController();
        const stopped = startGateway(params, runtime, controller).catch((error: unknown) => error);
        const turn = await first.promise;
        const end = turn.replyOptions?.queuedDeliveryCorrelations?.[0]?.begin();
        try {
          await dispatch.mock.results[0]?.value;
          await injectQaBusInboundMessage({
            baseUrl: params.account.baseUrl,
            input: { ...params.message, text: "second input" },
          });
          await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(2));
          expect(state.hasCompletedInboundEvent("default", 1)).toBe(false);
          expect(await visibleReplies(params.account.baseUrl)).toMatchObject([
            { text: "queued preview" },
          ]);
        } finally {
          if (typeof end === "function") {
            end({ visibleReplySent: false, completed: !failed, failed });
          }
          controller.abort();
          await stopped;
        }
        expect(await stopped).toEqual(
          failed ? new Error("QA queued reply did not complete delivery") : undefined,
        );
        expect(state.hasCompletedInboundEvent("default", 1)).toBe(!failed);
        expect(await visibleReplies(params.account.baseUrl)).toEqual([]);
      });
    },
  );

  it("keeps intake blocked when an early deferred notification ends in rejection", async () => {
    await withQaBus(async (params, state) => {
      const runtime = createPluginRuntimeMock();
      const entered = Promise.withResolvers<void>();
      const admission = Promise.withResolvers<void>();
      const dispatch = vi.mocked(runtime.channel.inbound.dispatch);
      dispatch.mockImplementationOnce(async (turn) => {
        turn.turnAdoptionLifecycle?.onDeferred?.();
        entered.resolve();
        await admission.promise;
        return acceptedDispatch(turn, "followup");
      });
      const polls = vi.spyOn(state, "poll");
      const controller = new AbortController();
      const stopped = startGateway(params, runtime, controller).catch((error: unknown) => error);
      try {
        await entered.promise;
        const { message } = await injectQaBusInboundMessage({
          baseUrl: params.account.baseUrl,
          input: { ...params.message, text: "second input" },
        });
        await vi.waitFor(() =>
          expect(
            polls.mock.results.some(
              (result) =>
                result.type === "return" &&
                result.value.events.some(
                  (event) => event.kind === "inbound-message" && event.message.id === message.id,
                ),
            ),
          ).toBe(true),
        );
        expect(dispatch).toHaveBeenCalledTimes(1);
      } finally {
        admission.reject(new Error("followup admission rejected"));
        controller.abort();
        await stopped;
      }
      expect(await stopped).toEqual(new Error("followup admission rejected"));
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(state.hasCompletedInboundEvent("default", 1)).toBe(false);
    });
  });

  it("retains a followup preview and handler until queued delivery completes", async () => {
    await withQaBus(async (params) => {
      const runtime = createPluginRuntimeMock();
      const dispatched =
        Promise.withResolvers<Parameters<typeof runtime.channel.inbound.dispatch>[0]>();
      vi.mocked(runtime.channel.inbound.dispatch).mockImplementationOnce(async (turn) => {
        await turn.replyOptions?.onPartialReply?.({ text: "queued preview" });
        dispatched.resolve(turn);
        return acceptedDispatch(turn, "followup");
      });
      let completed = false;
      const running = handleQaInbound({ ...params, channelRuntime: runtime.channel }).then(() => {
        completed = true;
      });
      const turn = await dispatched.promise;
      const correlation = turn.replyOptions?.queuedDeliveryCorrelations?.[0];
      let end = correlation?.begin();
      try {
        await vi.mocked(runtime.channel.inbound.dispatch).mock.results[0]?.value;
        if (typeof end === "function") {
          end(); // A retry has no terminal delivery receipt.
        }
        end = correlation?.begin();
        const preview = await visibleReplies(params.account.baseUrl);
        expect(completed).toBe(false);
        expect(preview).toMatchObject([{ text: "queued preview" }]);
        await turn.delivery.deliver?.({ text: "final reply" }, { kind: "final" });
        expect(await visibleReplies(params.account.baseUrl)).toMatchObject([
          { id: preview[0]?.id, text: "final reply" },
        ]);
        expect(completed).toBe(false);
      } finally {
        if (typeof end === "function") {
          end({ visibleReplySent: true, failed: false, completed: true });
        }
        await running;
      }
      expect(completed).toBe(true);
    });
  });

  it.each([
    { outcome: "direct", deferred: undefined, settlement: undefined, failed: false },
    { outcome: "steer", deferred: "steer", settlement: undefined, failed: false },
    {
      outcome: "early success",
      deferred: "followup",
      settlement: { visibleReplySent: false, completed: true, failed: false },
      failed: false,
    },
    {
      outcome: "cancelled",
      deferred: "followup",
      settlement: { visibleReplySent: false, completed: false, failed: false },
      failed: true,
    },
    {
      outcome: "failed",
      deferred: "followup",
      settlement: { visibleReplySent: false, completed: false, failed: true },
      failed: true,
    },
    {
      outcome: "transport pending",
      deferred: "followup",
      settlement: {
        visibleReplySent: false,
        completed: true,
        failed: false,
        transportPending: true,
      },
      failed: true,
    },
    {
      outcome: "abandoned",
      deferred: "followup",
      settlement: { visibleReplySent: false, failed: true },
      failed: true,
    },
  ] as const)(
    "settles $outcome dispatch and drains its preview",
    async ({ deferred, settlement, failed }) => {
      await withQaBus(async (params) => {
        const runtime = createPluginRuntimeMock();
        vi.mocked(runtime.channel.inbound.dispatch).mockImplementationOnce(async (turn) => {
          await turn.replyOptions?.onPartialReply?.({ text: "unfinished" });
          if (settlement) {
            const end = turn.replyOptions?.queuedDeliveryCorrelations?.[0]?.begin();
            if (typeof end === "function") {
              end(settlement);
            }
          }
          return acceptedDispatch(turn, deferred);
        });
        const onFollowupQueued = vi.fn();
        const running = handleQaInbound({
          ...params,
          channelRuntime: runtime.channel,
          onFollowupQueued,
        });
        if (failed) {
          await expect(running).rejects.toThrow("QA queued reply did not complete delivery");
        } else {
          await running;
        }
        expect(onFollowupQueued).toHaveBeenCalledTimes(Number(deferred === "followup"));
        expect(await visibleReplies(params.account.baseUrl)).toEqual([]);
      });
    },
  );

  it("removes the preview when the producer supplies an empty final", async () => {
    await withQaBus(async (params) => {
      await runQaInbound(async (turn) => {
        const dispatcher = createReplyDispatcher({ ...turn.dispatcherOptions, ...turn.delivery });
        try {
          await turn.replyOptions?.onPartialReply?.({ text: "unfinished" });
          expect(await visibleReplies(params.account.baseUrl)).toMatchObject([
            { text: "unfinished" },
          ]);
          expect(dispatcher.sendFinalReply({})).toBe(false);
          await turn.replyOptions?.onPartialReply?.({ text: "late partial" });
          expect(await visibleReplies(params.account.baseUrl)).toEqual([]);
        } finally {
          dispatcher.markComplete();
          await dispatcher.waitForIdle();
        }
      }, params);
      const state = await getQaBusState(params.account.baseUrl);
      expect(state.events.filter((event) => event.kind === "outbound-message")).toHaveLength(1);
      expect(state.events.filter((event) => event.kind === "message-deleted")).toHaveLength(1);
    });
  });

  it("removes an unfinished preview before a zero-payload dispatch returns", async () => {
    await withQaBus(async (params) => {
      await runQaInbound(async (turn) => {
        await turn.replyOptions?.onPartialReply?.({ text: "unfinished" });
        expect(await visibleReplies(params.account.baseUrl)).toMatchObject([
          { text: "unfinished" },
        ]);
      }, params);
      expect(await visibleReplies(params.account.baseUrl)).toEqual([]);
    });
  });

  it.each(["answer", "NO_REPLY", '{"text":"NO_REPLY"}'])(
    "keeps preview updates after an empty nonterminal block and preserves %s",
    async (text) => {
      await withQaBus(async (params) => {
        await runQaInbound(async (turn) => {
          const dispatcher = createReplyDispatcher({ ...turn.dispatcherOptions, ...turn.delivery });
          try {
            await turn.replyOptions?.onPartialReply?.({ text: "draft" });
            expect(dispatcher.sendBlockReply({ text: "" })).toBe(false);
            await turn.replyOptions?.onPartialReply?.({ text: "expanded draft" });
            expect(await visibleReplies(params.account.baseUrl)).toMatchObject([
              { text: "expanded draft" },
            ]);
            expect(dispatcher.sendFinalReply({ text })).toBe(true);
          } finally {
            dispatcher.markComplete();
            await dispatcher.waitForIdle();
          }
        }, params);
        expect(await visibleReplies(params.account.baseUrl)).toMatchObject([{ text }]);
        const state = await getQaBusState(params.account.baseUrl);
        expect(state.events.filter((event) => event.kind === "outbound-message")).toHaveLength(1);
        expect(state.events.filter((event) => event.kind === "message-deleted")).toHaveLength(0);
      });
    },
  );
});
