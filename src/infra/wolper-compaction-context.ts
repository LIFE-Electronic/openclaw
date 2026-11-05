import { streamSessionTranscriptLinesReverse } from "../config/sessions/transcript-stream.js";

/** Native message identity, independent of preview/model/compaction metadata writes. */
export async function readCompactionContext(
  transcript: string | undefined,
  sessionId: string,
): Promise<{ contextRevision: string | null; contextUpdatedAt: number | null }> {
  if (transcript) {
    // Read the tail only. Full transcript scans on the scheduler would scale with
    // lifetime history, even when a session has had no new model work.
    for await (const line of streamSessionTranscriptLinesReverse(transcript)) {
      let entry: { type?: string; id?: string; timestamp?: string };
      try {
        entry = JSON.parse(line);
      } catch {
        continue; // A partially appended final line is not committed context.
      }
      if (entry.type !== "message" || typeof entry.id !== "string") {
        continue;
      }
      const timestamp = Date.parse(entry.timestamp ?? "");
      if (!Number.isFinite(timestamp)) {
        return { contextRevision: null, contextUpdatedAt: null };
      }
      return { contextRevision: `${sessionId}:${entry.id}`, contextUpdatedAt: timestamp };
    }
  }
  return { contextRevision: null, contextUpdatedAt: null };
}
