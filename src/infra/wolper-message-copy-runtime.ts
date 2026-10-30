/** Append through the native transcript writer; no dispatch, inference, or transport side effect. */
import { randomUUID } from "node:crypto";
import { replyRunRegistry } from "../auto-reply/reply/reply-run-registry.js";
import { getRuntimeConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { resolveDefaultSessionStorePath } from "../config/sessions/paths.js";
import { loadSessionStore, updateSessionStore } from "../config/sessions/store.js";
import { appendExactAssistantMessageToSessionTranscript } from "../config/sessions/transcript.js";
import {
  copyMessage,
  copyRequestSchema,
  CopyBusyError,
  CopyConflictError,
  type CopyRequest,
  type CopyResult,
} from "./wolper-message-copy.js";

export async function copyIntoSession(request: CopyRequest): Promise<CopyResult> {
  request = copyRequestSchema.parse(request);
  const agentId = request.destinationSessionKey.split(":")[1];
  const storePath = resolveDefaultSessionStorePath(agentId);
  return await copyMessage(request, {
    stateDir: resolveStateDir(),
    resolveSession: async (input, expectedSessionId) => {
      let sessionId = "";
      await updateSessionStore(storePath, (store) => {
        const existing = store[input.destinationSessionKey];
        if (expectedSessionId && existing?.sessionId !== expectedSessionId) {
          throw new CopyConflictError("Native copy session changed");
        }
        const entry = existing ?? { sessionId: randomUUID(), updatedAt: Date.now() };
        store[input.destinationSessionKey] = entry;
        sessionId = entry.sessionId;
      });
      return { sessionId, busy: replyRunRegistry.isActive(input.destinationSessionKey) };
    },
    append: async (input, sessionId) => {
      const appended = await appendExactAssistantMessageToSessionTranscript({
        agentId,
        storePath,
        sessionKey: input.destinationSessionKey,
        idempotencyKey: `wolper-copy:${input.copyId}`,
        returnMessage: true,
        config: getRuntimeConfig(),
        beforeAppend: () => {
          if (replyRunRegistry.isActive(input.destinationSessionKey)) {
            throw new CopyBusyError();
          }
          if (
            loadSessionStore(storePath, { skipCache: true })[input.destinationSessionKey]
              ?.sessionId !== sessionId
          ) {
            throw new CopyConflictError("Native copy session changed");
          }
        },
        message: {
          role: "assistant",
          content:
            typeof input.message.content === "string"
              ? [{ type: "text", text: input.message.content }]
              : input.message.content,
          __openclaw: { runId: input.executionId, origin: input.origin, copyId: input.copyId },
          api: "openai-responses",
          provider: "openclaw",
          model: "wolper-background-copy",
          stopReason: "stop",
          timestamp: Date.now(),
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          // Assistant media is supported by native transcripts but not described
          // by the narrower provider-facing AssistantMessage content union.
        } as unknown as Parameters<
          typeof appendExactAssistantMessageToSessionTranscript
        >[0]["message"],
      });
      if (!appended.ok || !appended.message) {
        throw new Error("Native copy publication failed");
      }
      return {
        messageId: appended.messageId,
        message: copyRequestSchema.shape.message.parse(appended.message),
      };
    },
  });
}
