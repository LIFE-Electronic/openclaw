import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { createReplyDispatcher } from "openclaw/plugin-sdk/reply-runtime";
import { describe, expect, it, vi } from "vitest";
import { createQaBusState, startQaBusServer } from "../../qa-lab/bus-api.js";
import { getQaBusState, injectQaBusInboundMessage } from "./bus-client.js";
import { handleQaInbound } from "./inbound.js";
import { createQaInboundParams, runQaInbound } from "./inbound.test-harness.js";

async function withQaBus(run: (params: ReturnType<typeof createQaInboundParams>) => Promise<void>) {
  const bus = await startQaBusServer({ state: createQaBusState() });
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
    await run(params);
  } finally {
    await bus.stop();
  }
}

async function visibleReplies(baseUrl: string) {
  const state = await getQaBusState(baseUrl);
  return state.messages.filter((message) => message.direction === "outbound" && !message.deleted);
}

describe("QA inbound dispatch settlement", () => {
  it("retains a followup preview and handler until queued delivery completes", async () => {
    await withQaBus(async (params) => {
      const runtime = createPluginRuntimeMock();
      const dispatched =
        Promise.withResolvers<Parameters<typeof runtime.channel.inbound.dispatch>[0]>();
      vi.mocked(runtime.channel.inbound.dispatch).mockImplementationOnce(async (turn) => {
        await turn.replyOptions?.onPartialReply?.({ text: "queued preview" });
        dispatched.resolve(turn);
        return {
          admission: { kind: "dispatch" },
          dispatched: true,
          ctxPayload: turn.ctxPayload,
          routeSessionKey: turn.route.sessionKey,
          dispatchResult: {
            queuedFinal: false,
            counts: { tool: 0, block: 0, final: 0 },
            deferredToActiveRun: "followup",
          },
        };
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
          return {
            admission: { kind: "dispatch" },
            dispatched: true,
            ctxPayload: turn.ctxPayload,
            routeSessionKey: turn.route.sessionKey,
            dispatchResult: {
              queuedFinal: false,
              counts: { tool: 0, block: 0, final: 0 },
              deferredToActiveRun: deferred,
            },
          };
        });
        const running = handleQaInbound({ ...params, channelRuntime: runtime.channel });
        if (failed) {
          await expect(running).rejects.toThrow("QA queued reply did not complete delivery");
        } else {
          await running;
        }
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
