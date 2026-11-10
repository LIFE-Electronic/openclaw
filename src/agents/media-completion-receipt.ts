import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { formatErrorMessage } from "../infra/errors.js";
import { onSessionTranscriptUpdate } from "../sessions/transcript-events.js";

export type MediaCompletionAcceptance =
  | { status: "accepted" }
  | { status: "deferred"; error?: string }
  | { status: "failed"; error: string };

type CompletionInput = {
  sessionKey: string;
  sourceSessionKey: string;
  triggerMessage: string;
  sessionFile?: string;
};

function matchesCompletionInput(message: unknown, input: CompletionInput): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  const row = message as Record<string, unknown>;
  if (row.role !== "user") {
    return false;
  }
  const provenance = row.provenance as Record<string, unknown> | undefined;
  if (provenance) {
    if (provenance.kind !== "inter_session") {
      return false;
    }
    if (provenance.sourceSessionKey === input.sourceSessionKey) {
      return true;
    }
  }
  // Steered messages belong to the active turn rather than a new agent RPC.
  // The transcript guard can inherit the foreground run's internal provenance.
  // Only the exact completion payload is a receipt in that path.
  const text =
    typeof row.content === "string"
      ? row.content
      : Array.isArray(row.content)
        ? row.content
            .map((part: { type?: string; text?: string }) =>
              part.type === "text" ? (part.text ?? "") : "",
            )
            .join("")
        : "";
  return text === input.triggerMessage;
}

async function hasPersistedCompletionInput(input: CompletionInput): Promise<boolean> {
  if (!input.sessionFile) {
    return false;
  }
  try {
    const info = await stat(input.sessionFile);
    // Recovery reads only the selected session, never an unbounded fleet scan.
    if (info.size > 64 * 1024 * 1024) {
      throw new Error("Media completion receipt transcript exceeds read limit");
    }
    const stream = createReadStream(input.sessionFile);
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        let entry: { type?: string; message?: unknown };
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        if (entry.type === "message" && matchesCompletionInput(entry.message, input)) {
          return true;
        }
      }
    } finally {
      lines.close();
      stream.destroy();
    }
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

/** Acknowledge persisted session input, never the completion agent's final reply. */
export async function acceptMediaCompletionInput(
  params: CompletionInput & {
    dispatch: () => Promise<unknown>;
    timeoutMs: number;
  },
): Promise<MediaCompletionAcceptance> {
  let accepted = false;
  let resolveReceipt: () => void = () => {};
  const receipt = new Promise<void>((resolve) => {
    resolveReceipt = resolve;
  });
  const unsubscribe = onSessionTranscriptUpdate((update) => {
    if (
      update.sessionKey !== params.sessionKey &&
      (!params.sessionFile || update.sessionFile !== params.sessionFile)
    ) {
      return;
    }
    if (matchesCompletionInput(update.message, params)) {
      accepted = true;
      resolveReceipt();
    }
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if ((await hasPersistedCompletionInput(params)) || accepted) {
      return { status: "accepted" };
    }
    const expiry = new Promise<MediaCompletionAcceptance>((resolve) => {
      timer = setTimeout(
        () =>
          resolve({ status: "deferred", error: "Completion input acceptance is still pending" }),
        params.timeoutMs,
      );
      timer.unref?.();
    });
    // Subscribe before dispatch: an in-process Gateway can persist input before
    // returning its admission acknowledgement, including before a lost response.
    const committed = receipt.then((): MediaCompletionAcceptance => ({ status: "accepted" }));
    const admission = params
      .dispatch()
      .then(async (response): Promise<MediaCompletionAcceptance> => {
        const acknowledgement = response as
          | { inputAccepted?: boolean; deferred?: boolean }
          | undefined;
        if (acknowledgement?.inputAccepted) {
          return { status: "accepted" };
        }
        if (acknowledgement?.deferred) {
          return { status: "deferred" };
        }
        return committed;
      })
      .catch(async (error): Promise<MediaCompletionAcceptance> => {
        if (accepted || (await hasPersistedCompletionInput(params))) {
          return { status: "accepted" };
        }
        return { status: "failed", error: formatErrorMessage(error) };
      });
    return await Promise.race([committed, admission, expiry]);
  } catch (error) {
    return { status: "failed", error: formatErrorMessage(error) };
  } finally {
    unsubscribe();
    if (timer) {
      clearTimeout(timer);
    }
  }
}
