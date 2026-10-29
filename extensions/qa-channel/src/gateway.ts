import type { ChannelGatewayContext } from "openclaw/plugin-sdk/channel-contract";
import type { PluginRuntime } from "openclaw/plugin-sdk/channel-core";
import { buildChannelInboundEventContext } from "openclaw/plugin-sdk/channel-inbound";
import { channelReadyPatch, channelStoppedPatch } from "openclaw/plugin-sdk/gateway-runtime";
import { pollQaBus } from "./bus-client.js";
import { handleQaInbound } from "./inbound.js";
import type { CoreConfig, ResolvedQaChannelAccount } from "./types.js";

export async function startQaGatewayAccount(
  channelId: string,
  channelLabel: string,
  ctx: ChannelGatewayContext<ResolvedQaChannelAccount>,
) {
  const account = ctx.account;
  const channelRuntime = ctx.channelRuntime as PluginRuntime["channel"] | undefined;
  const buildContext = channelRuntime?.inbound.buildContext ?? buildChannelInboundEventContext;
  if (!account.configured) {
    throw new Error(`QA channel is not configured for account "${account.accountId}"`);
  }
  ctx.setStatus({
    accountId: account.accountId,
    running: true,
    lifecycle: "starting",
    configured: true,
    enabled: account.enabled,
    baseUrl: account.baseUrl,
  });
  let cursor = 0;
  let adoptedCursor = 0;
  let acknowledgedCursor = 0;
  let committedAdoptedCursor = 0;
  let committedAcknowledgedCursor = 0;
  let queuedCursor = 0;
  let acknowledgementStopped = false;
  let ready = false;
  let inboundError: Error | undefined;
  let queuedInbound = Promise.resolve();
  let queuedAcknowledgements = Promise.resolve();
  const controlTasks = new Set<Promise<void>>();
  type PendingEvent = {
    cursor: number;
    state: "pending" | "adopted" | "abandoned";
    completed: boolean;
  };
  const pendingAdoptions: PendingEvent[] = [];
  const pendingCompletions: PendingEvent[] = [];
  const captureInboundError = (error: unknown) => {
    inboundError ??= error instanceof Error ? error : new Error(String(error));
  };
  const markAdopted = (event: PendingEvent) => {
    event.state = "adopted";
    while (pendingAdoptions[0]?.state === "adopted") {
      adoptedCursor = pendingAdoptions.shift()!.cursor;
    }
  };
  const markCompleted = (event: PendingEvent) => {
    markAdopted(event);
    event.completed = true;
    while (pendingCompletions[0]?.completed) {
      acknowledgedCursor = pendingCompletions.shift()!.cursor;
    }
  };
  const flushAcknowledgements = () => {
    const flush = queuedAcknowledgements.then(async () => {
      if (acknowledgementStopped) {
        throw inboundError ?? new Error("QA channel acknowledgement owner stopped");
      }
      const adopted = adoptedCursor;
      const completed = acknowledgedCursor;
      if (adopted <= committedAdoptedCursor && completed <= committedAcknowledgedCursor) {
        return;
      }
      // Adoption must confirm transport custody before execution can continue.
      // Only the main poll consumes events; this response cannot advance fetch progress.
      await pollQaBus({
        baseUrl: account.baseUrl,
        accountId: account.accountId,
        cursor: Math.max(adopted, completed),
        adoptedCursor: adopted,
        acknowledgedCursor: completed,
        timeoutMs: 0,
      });
      committedAdoptedCursor = Math.max(committedAdoptedCursor, adopted);
      committedAcknowledgedCursor = Math.max(committedAcknowledgedCursor, completed);
    });
    queuedAcknowledgements = flush.catch((error: unknown) => {
      acknowledgementStopped = true;
      captureInboundError(error);
    });
    return flush;
  };
  const handleMessage = async (
    message: Parameters<typeof handleQaInbound>[0]["message"],
    event: PendingEvent,
  ) => {
    await handleQaInbound({
      channelId,
      channelLabel,
      account,
      config: ctx.cfg as CoreConfig,
      message,
      buildContext,
      ...(channelRuntime ? { channelRuntime } : {}),
      // Keep QA collect batching; core awaits adoption for every collected source.
      turnAdoptionLifecycle: {
        onAdopted: async () => {
          if (acknowledgementStopped || event.state === "abandoned") {
            throw inboundError ?? new Error("QA input adoption is no longer available");
          }
          markAdopted(event);
          // Native controls may overtake an unadopted input. Flush the available
          // prefix without waiting for that predecessor's handler or adoption.
          await flushAcknowledgements();
        },
        onAbandoned: () => {
          if (event.state !== "adopted") {
            event.state = "abandoned";
            captureInboundError(new Error("QA input abandoned before adoption"));
          }
        },
      },
    });
    // Policy refusals and terminal no-turn handlers still consume their event.
    // handleQaInbound also joins deferred delivery and preview cleanup.
    if (event.state === "pending" || event.state === "adopted") {
      markCompleted(event);
    }
  };
  const dispatchControl = (
    message: Parameters<typeof handleQaInbound>[0]["message"],
    event: PendingEvent,
  ) => {
    const task = handleMessage(message, event)
      .catch(captureInboundError)
      .finally(() => controlTasks.delete(task));
    controlTasks.add(task);
  };
  const enqueueInbound = (
    message: Parameters<typeof handleQaInbound>[0]["message"],
    event: PendingEvent,
  ) => {
    queuedInbound = queuedInbound
      .then(async () => {
        if (inboundError) {
          return;
        }
        await handleMessage(message, event);
      })
      .catch(captureInboundError);
  };
  const queueEvent = (eventCursor: number): PendingEvent | undefined => {
    if (eventCursor <= queuedCursor) {
      return undefined;
    }
    queuedCursor = eventCursor;
    const event: PendingEvent = { cursor: eventCursor, state: "pending", completed: false };
    pendingAdoptions.push(event);
    pendingCompletions.push(event);
    return event;
  };
  try {
    while (!ctx.abortSignal.aborted) {
      if (inboundError) {
        throw inboundError;
      }
      const pollAcknowledgedCursor = acknowledgedCursor;
      const pollAdoptedCursor = adoptedCursor;
      const result = await pollQaBus({
        baseUrl: account.baseUrl,
        accountId: account.accountId,
        cursor,
        acknowledgedCursor: pollAcknowledgedCursor,
        adoptedCursor: pollAdoptedCursor,
        timeoutMs: account.pollTimeoutMs,
        signal: ctx.abortSignal,
      });
      committedAcknowledgedCursor = Math.max(committedAcknowledgedCursor, pollAcknowledgedCursor);
      committedAdoptedCursor = Math.max(committedAdoptedCursor, pollAdoptedCursor);
      if (!ready) {
        ready = true;
        ctx.setStatus(channelReadyPatch({ accountId: account.accountId }));
      }
      cursor = result.cursor;
      for (const event of result.events) {
        const acknowledgement = queueEvent(event.cursor);
        if (!acknowledgement) {
          continue;
        }
        if (event.kind !== "inbound-message") {
          markCompleted(acknowledgement);
          continue;
        }
        if (event.message.nativeCommand) {
          dispatchControl(event.message, acknowledgement);
        } else {
          enqueueInbound(event.message, acknowledgement);
        }
      }
      const tail = queueEvent(cursor);
      if (tail) {
        markCompleted(tail);
      }
    }
    if (inboundError) {
      throw inboundError;
    }
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "AbortError") {
      ctx.setStatus({
        accountId: account.accountId,
        connected: false,
        lifecycle: "recovering",
        lastError: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  } finally {
    try {
      await Promise.all([queuedInbound, ...controlTasks]);
      // Join started writes and flush completed handlers without the cancelled
      // poll signal. Failed inputs leave gaps in the completion checkpoint.
      await flushAcknowledgements();
    } catch (error) {
      captureInboundError(error);
    } finally {
      acknowledgementStopped = true;
      ctx.setStatus(channelStoppedPatch({ accountId: account.accountId }));
    }
  }
  if (inboundError) {
    throw inboundError;
  }
}
