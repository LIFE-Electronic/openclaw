import type { ChannelGatewayContext } from "openclaw/plugin-sdk/channel-contract";
import { createStartAccountContext } from "openclaw/plugin-sdk/channel-test-helpers";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createQaBusState, startQaBusServer } from "../../qa-lab/bus-api.js";
import { pollQaBus } from "./bus-client.js";
import { startQaGatewayAccount } from "./gateway.js";
import { jsonServer as json } from "./http.test-support.js";
import { handleQaInbound } from "./inbound.js";
import type { ResolvedQaChannelAccount } from "./types.js";

vi.mock("./inbound.js", () => ({
  handleQaInbound: vi.fn(async () => undefined),
}));

function startGateway(
  baseUrl: string,
  options: {
    abortSignal?: AbortSignal;
    pollTimeoutMs?: number;
    setStatus?: ChannelGatewayContext<ResolvedQaChannelAccount>["setStatus"];
  } = {},
) {
  return startQaGatewayAccount("qa-channel", "QA Channel", {
    ...createStartAccountContext({
      account: {
        accountId: "default",
        baseUrl,
        botDisplayName: "QA Bot",
        botUserId: "qa-bot",
        config: {},
        configured: true,
        enabled: true,
        pollTimeoutMs: options.pollTimeoutMs ?? 1,
      },
      abortSignal: options.abortSignal,
    }),
    setStatus: options.setStatus ?? vi.fn(),
  });
}

function createInboundMessage(text: string, index = 0) {
  return {
    id: `msg-${index + 1}`,
    accountId: "default",
    direction: "inbound" as const,
    conversation: { id: "alice", kind: "direct" as const },
    senderId: "alice",
    text,
    timestamp: Date.now(),
    reactions: [],
    ...(text === "/stop" ? { nativeCommand: { name: "stop" } } : {}),
  };
}

describe("qa-channel gateway", () => {
  function serveMessages(...texts: string[]) {
    return json(() => ({
      body: JSON.stringify({
        cursor: texts.length,
        events: texts.map((text, index) => ({
          cursor: index + 1,
          kind: "inbound-message",
          accountId: "default",
          message: createInboundMessage(text, index),
        })),
      }),
    }));
  }
  async function busWithMessages(...texts: string[]) {
    const state = createQaBusState();
    const bus = await startQaBusServer({ state });
    onTestFinished(() => bus.stop());
    const messages = texts.map((text) =>
      state.addInboundMessage({
        accountId: "default",
        conversation: { id: "alice", kind: "direct" },
        senderId: "alice",
        text,
        ...(text === "/stop" ? { nativeCommand: { name: "stop" } } : {}),
      }),
    );
    return { state, bus, messages };
  }
  const handledTexts = () =>
    vi.mocked(handleQaInbound).mock.calls.map(([params]) => params.message.text);

  afterEach(() => {
    vi.mocked(handleQaInbound).mockReset().mockResolvedValue(undefined);
  });

  it("lets native commands bypass the ordered inbound queue", async () => {
    const controller = new AbortController();
    const baseUrl = await serveMessages("hello", "follow-up", "/stop");
    const { promise: firstPending, resolve: releaseFirst } = Promise.withResolvers<void>();
    vi.mocked(handleQaInbound).mockImplementation(async ({ message: inbound }) => {
      if (inbound.text === "hello") {
        await firstPending;
      }
      if (inbound.text === "/stop") {
        controller.abort();
      }
    });

    const gateway = startGateway(baseUrl, { abortSignal: controller.signal });

    await vi.waitFor(() => {
      const handled = handledTexts();
      expect(handled).toContain("hello");
      expect(handled).toContain("/stop");
      expect(handled).not.toContain("follow-up");
    });
    releaseFirst?.();
    await gateway;
    const handled = handledTexts();
    expect(handled).toHaveLength(3);
    expect(handled).toContain("/stop");
    expect(handled.indexOf("hello")).toBeLessThan(handled.indexOf("follow-up"));
  });

  it("clears running status when polling fails", async () => {
    const baseUrl = await json(() => ({
      statusCode: 500,
      body: JSON.stringify({ error: "qa bus unavailable" }),
    }));
    const setStatus = vi.fn();

    await expect(startGateway(baseUrl, { setStatus })).rejects.toThrow("qa bus unavailable");

    expect(setStatus.mock.calls.map(([status]) => status)).toEqual([
      {
        accountId: "default",
        baseUrl,
        configured: true,
        enabled: true,
        running: true,
        lifecycle: "starting",
      },
      {
        accountId: "default",
        connected: false,
        lifecycle: "recovering",
        lastError: "qa bus unavailable",
      },
      {
        accountId: "default",
        running: false,
        connected: false,
        lifecycle: "stopped",
      },
    ]);
  });

  it("publishes ready after the first successful poll", async () => {
    const controller = new AbortController();
    const baseUrl = await json(() => ({
      body: JSON.stringify({ cursor: 0, events: [] }),
    }));
    const setStatus = vi.fn();

    const run = startGateway(baseUrl, { abortSignal: controller.signal, setStatus });

    await vi.waitFor(() =>
      expect(setStatus).toHaveBeenCalledWith({
        accountId: "default",
        running: true,
        connected: true,
        lifecycle: "ready",
        lastConnectedAt: expect.any(Number),
        lastError: null,
        terminalDisconnect: undefined,
      }),
    );
    controller.abort();
    await run;
  });

  it("stops the ordered inbound queue after the first dispatch failure", async () => {
    const controller = new AbortController();
    const baseUrl = await serveMessages("first", "second");
    vi.mocked(handleQaInbound).mockImplementationOnce(async () => {
      controller.abort();
      throw new Error("inbound failed");
    });

    await expect(startGateway(baseUrl, { abortSignal: controller.signal })).rejects.toThrow(
      "inbound failed",
    );
    expect(handleQaInbound).toHaveBeenCalledTimes(1);
  });

  it("acknowledges only the contiguous prefix when dispatches finish out of order", async () => {
    const { state, bus, messages } = await busWithMessages("first", "second", "/stop");
    let pollCount = 0;
    bus.server.on("request", (request) => {
      if (request.url === "/v1/poll") {
        pollCount += 1;
      }
    });

    const { promise: secondAttempt, reject: rejectSecond } = Promise.withResolvers<void>();
    let restarting = false;
    const recoveredMessageIds: string[] = [];
    const restartedController = new AbortController();
    vi.mocked(handleQaInbound).mockImplementation(async ({ message }) => {
      if (!restarting && message.id === messages[1]?.id) {
        await secondAttempt;
      }
      if (restarting) {
        recoveredMessageIds.push(message.id);
        if (recoveredMessageIds.length === messages.length - 1) {
          restartedController.abort();
        }
      }
    });
    const firstGateway = startGateway(bus.baseUrl, {
      abortSignal: new AbortController().signal,
      pollTimeoutMs: 10,
    });

    await vi.waitFor(() => {
      expect(pollCount).toBeGreaterThanOrEqual(2);
      expect(vi.mocked(handleQaInbound).mock.calls.map(([params]) => params.message.id)).toEqual(
        expect.arrayContaining(messages.map((message) => message.id)),
      );
    });
    rejectSecond(new Error("inbound failed"));
    await expect(firstGateway).rejects.toThrow("inbound failed");
    expect(state.getAcknowledgedPollCursor("default")).toBe(1);

    restarting = true;
    const restartedGateway = startGateway(bus.baseUrl, {
      abortSignal: restartedController.signal,
      pollTimeoutMs: 10,
    });
    try {
      await vi.waitFor(() => {
        expect(new Set(recoveredMessageIds)).toEqual(
          new Set(messages.slice(1).map((message) => message.id)),
        );
      });
    } finally {
      restartedController.abort();
      await restartedGateway.catch(() => undefined);
    }
  });

  it("records a final successful dispatch before the gateway stops", async () => {
    const { state, bus, messages } = await busWithMessages("stop after delivery");
    const controller = new AbortController();
    vi.mocked(handleQaInbound).mockImplementation(async ({ message: inbound }) => {
      if (inbound.id === messages[0]?.id) {
        controller.abort();
      }
    });

    await startGateway(bus.baseUrl, { abortSignal: controller.signal, pollTimeoutMs: 10 });

    expect(state.getAcknowledgedPollCursor("default")).toBe(1);
  });

  it("confirms adopted input at the bus before its handler completes", async () => {
    const { state, bus } = await busWithMessages("long-running input");
    const controller = new AbortController();
    const adopted = Promise.withResolvers<void>();
    const handler = Promise.withResolvers<void>();
    let handlerCompleted = false;
    vi.mocked(handleQaInbound).mockImplementation(async ({ turnAdoptionLifecycle }) => {
      await turnAdoptionLifecycle?.onAdopted();
      adopted.resolve();
      await handler.promise;
      handlerCompleted = true;
    });
    const gateway = startGateway(bus.baseUrl, {
      abortSignal: controller.signal,
      pollTimeoutMs: 10,
    });
    try {
      await adopted.promise;
      const restartedPoll = await pollQaBus({
        baseUrl: bus.baseUrl,
        accountId: "default",
        cursor: 0,
        acknowledgedCursor: 0,
        timeoutMs: 0,
      });
      expect(restartedPoll.events).toEqual([]);
      expect(state.getAcknowledgedPollCursor("default")).toBe(0);
      expect(handlerCompleted).toBe(false);
    } finally {
      handler.resolve();
      controller.abort();
      await gateway;
    }
    expect(state.getAcknowledgedPollCursor("default")).toBe(1);
  });

  it("lets native adoption pass an unadopted input without acknowledging it", async () => {
    const { state, bus } = await busWithMessages("deferred", "/stop");
    const controller = new AbortController();
    const deferred =
      Promise.withResolvers<
        NonNullable<Parameters<typeof handleQaInbound>[0]["turnAdoptionLifecycle"]>
      >();
    const controlAdopted = Promise.withResolvers<number>();
    const control = Promise.withResolvers<void>();
    const input = Promise.withResolvers<void>();
    vi.mocked(handleQaInbound).mockImplementation(async ({ message, turnAdoptionLifecycle }) => {
      if (!turnAdoptionLifecycle) {
        throw new Error("missing input adoption lifecycle");
      }
      if (message.text === "deferred") {
        deferred.resolve(turnAdoptionLifecycle);
        await input.promise;
        return;
      }
      await turnAdoptionLifecycle.onAdopted();
      controlAdopted.resolve(state.resolvePollCursor({ accountId: "default" }));
      await control.promise;
    });
    const gateway = startGateway(bus.baseUrl, {
      abortSignal: controller.signal,
      pollTimeoutMs: 10,
    });
    try {
      const lifecycle = await deferred.promise;
      expect(await controlAdopted.promise).toBe(0);
      expect(state.getAcknowledgedPollCursor("default")).toBe(0);
      await lifecycle.onAdopted();
      expect(state.resolvePollCursor({ accountId: "default" })).toBe(2);
      expect(state.getAcknowledgedPollCursor("default")).toBe(0);
    } finally {
      input.resolve();
      control.resolve();
      controller.abort();
      await gateway;
    }
    expect(state.getAcknowledgedPollCursor("default")).toBe(2);
  });

  it.each([
    { failure: "after adoption", adopted: 1, error: "inbound failed" },
    { failure: "abandoned input", adopted: 0, error: "QA input abandoned before adoption" },
  ])("preserves transport custody: $failure", async ({ failure, adopted, error }) => {
    const { state, bus } = await busWithMessages("failing input");
    vi.mocked(handleQaInbound).mockImplementation(async ({ turnAdoptionLifecycle }) => {
      if (failure === "abandoned input") {
        await turnAdoptionLifecycle?.onAbandoned?.();
        return;
      }
      if (failure === "after adoption") {
        await turnAdoptionLifecycle?.onAdopted();
      }
      throw new Error("inbound failed");
    });

    await expect(startGateway(bus.baseUrl)).rejects.toThrow(error);
    expect(state.resolvePollCursor({ accountId: "default" })).toBe(adopted);
    expect(state.getAcknowledgedPollCursor("default")).toBe(0);
  });

  it("rejects adoption when the bus cannot confirm acknowledgement", async () => {
    let unavailable = false;
    const baseUrl = await json(() =>
      unavailable
        ? {
            statusCode: 503,
            body: JSON.stringify({ error: "acknowledgement unavailable" }),
          }
        : {
            body: JSON.stringify({
              cursor: 1,
              events: [
                {
                  cursor: 1,
                  kind: "inbound-message",
                  accountId: "default",
                  message: createInboundMessage("failing acknowledgement"),
                },
              ],
            }),
          },
    );
    let adopted = false;
    let adoptionError: unknown;
    vi.mocked(handleQaInbound).mockImplementation(async ({ turnAdoptionLifecycle }) => {
      unavailable = true;
      try {
        await turnAdoptionLifecycle?.onAdopted();
        adopted = true;
      } catch (error) {
        adoptionError = error;
        throw error;
      }
    });

    await expect(startGateway(baseUrl)).rejects.toThrow("acknowledgement unavailable");
    expect(adoptionError).toEqual(new Error("acknowledgement unavailable"));
    expect(adopted).toBe(false);
  });
});
