/** Native execution integration; the storage contract itself never initializes a Gateway. */
import { randomUUID } from "node:crypto";
import type { ReplyPayload } from "../auto-reply/types.js";
import { getRuntimeConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { resolveDefaultSessionStorePath } from "../config/sessions/paths.js";
import { updateSessionStore } from "../config/sessions/store.js";
import { appendExactAssistantMessageToSessionTranscript } from "../config/sessions/transcript.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { emitAgentEvent, registerAgentRunContext } from "./agent-events.js";
import {
  backgroundMessage,
  enqueueBackgroundResult,
  type BackgroundExecution,
  type BackgroundResult,
} from "./wolper-background.js";

export async function publishBackgroundResult(params: {
  execution: BackgroundExecution;
  sourceSessionKey: string;
  destinationSessionKey: string;
  outcome: "completed" | "failed";
  payloads: ReplyPayload[];
  cfg: OpenClawConfig;
}): Promise<void> {
  const result: BackgroundResult = {
    version: 1,
    executionId: params.execution.runId,
    origin: params.execution.origin,
    sourceSessionKey: params.sourceSessionKey,
    destinationSessionKey: params.destinationSessionKey,
    completedAt: new Date().toISOString(),
    outcome: params.outcome,
    message:
      params.outcome === "failed"
        ? { role: "assistant", content: "Scheduled task failed. Check its run status for details." }
        : backgroundMessage(params.payloads),
  };
  await enqueueBackgroundResult(resolveStateDir(), result, true);
  registerAgentRunContext(params.execution.runId, {
    sessionKey: params.sourceSessionKey,
    origin: params.execution.origin,
  });
  emitAgentEvent({
    runId: params.execution.runId,
    stream: "wolper.background.ready",
    sessionKey: params.sourceSessionKey,
    data: { destinationSessionKey: params.destinationSessionKey },
  });
}

/** Mirror isolated output into the selected native conversation exactly once. */
export async function materializeBackgroundResult(result: BackgroundResult): Promise<void> {
  if (result.sourceSessionKey === result.destinationSessionKey || result.outcome === "silent") {
    return;
  }
  const text =
    typeof result.message.content === "string"
      ? result.message.content
      : Array.isArray(result.message.content)
        ? result.message.content
            .map((item) =>
              item && typeof item === "object" && "text" in item ? String(item.text) : "",
            )
            .join("\n")
        : "";
  const media =
    Array.isArray(result.message.content) &&
    result.message.content.some(
      (item) => item && typeof item === "object" && "type" in item && item.type === "image",
    );
  if (!media && (!text.trim() || /^(?:HEARTBEAT_OK|NO_REPLY)[.!]?$/u.test(text.trim()))) {
    return;
  }
  const match = /^agent:([^:]+):.+/u.exec(result.destinationSessionKey);
  if (!match) {
    throw new Error("Invalid BlueHouse destination");
  }
  const agentId = match[1];
  const storePath = resolveDefaultSessionStorePath(agentId);
  await updateSessionStore(storePath, (store) => {
    // Provisioning may register Wolper Main before its first native user turn.
    if (!store[result.destinationSessionKey]) {
      store[result.destinationSessionKey] = {
        sessionId: randomUUID(),
        updatedAt: Date.now(),
      };
    }
  });
  const appended = await appendExactAssistantMessageToSessionTranscript({
    agentId,
    sessionKey: result.destinationSessionKey,
    storePath,
    idempotencyKey: `wolper-background:${result.executionId}`,
    config: getRuntimeConfig(),
    message: {
      ...result.message,
      role: "assistant",
      content:
        typeof result.message.content === "string"
          ? [{ type: "text", text: result.message.content }]
          : result.message.content,
      __openclaw: { runId: result.executionId, origin: result.origin },
      api: "openai-responses",
      provider: "openclaw",
      model: "wolper-background",
      stopReason: "stop",
      timestamp: Date.parse(result.completedAt),
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    } as Parameters<typeof appendExactAssistantMessageToSessionTranscript>[0]["message"],
  });
  if (!appended.ok) {
    throw new Error("Native BlueHouse result publication failed");
  }
}
