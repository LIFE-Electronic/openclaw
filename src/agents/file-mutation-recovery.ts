import { createHash } from "node:crypto";
import path from "node:path";
import { root as fsRoot } from "../infra/fs-safe.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import { resolveToCwd } from "./sessions/tools/path-utils.js";
import { asRecord } from "./tool-display-record.js";
import { extractFileTargetPath, isMutatingToolCall } from "./tool-mutation.js";

type RecoveryContext = {
  workspaceDir: string;
  cwd: string;
  /** Only the built-in local shell can establish local file recovery. */
  localExec: boolean;
};
type PendingFileFailure = { callId: string; file: string; context: RecoveryContext };
const MAX_RECOVERY_BYTES = 1024 * 1024;

/** Observe execution, not asynchronous lifecycle notifications, to avoid snapshot races. */
export class FileMutationRecovery {
  private pending?: PendingFileFailure;
  private generation = 0;
  private activeMutations = new Set<string>();
  private hasBackgroundMutation = false;
  private recovered = new Map<string, string>();

  /** Evidence is run-local and never accepted from model-visible tool result metadata. */
  consumeRecovery(callId: string): string | undefined {
    const failedCallId = this.recovered.get(callId);
    this.recovered.delete(callId);
    return failedCallId;
  }

  wrap(tool: AnyAgentTool, context: RecoveryContext): AnyAgentTool {
    return {
      ...tool,
      execute: async (callId, args, signal, onUpdate) => {
        const mutating = isMutatingToolCall(tool.name, args);
        if (mutating) {
          this.generation++;
          this.activeMutations.add(callId);
        }
        const generation = this.generation;
        const host = asRecord(args)?.host;
        const isLocalCommand =
          context.localExec &&
          (tool.name === "exec" || tool.name === "bash") &&
          (host == null || host === "auto" || host === "gateway");
        const candidate = isLocalCommand && !this.hasBackgroundMutation ? this.pending : undefined;
        const exclusive = () => this.generation === generation && this.activeMutations.size === 1;
        try {
          const before = candidate && exclusive() ? await this.snapshot(candidate) : undefined;
          const result = await tool.execute(callId, args, signal, onUpdate);
          const details = asRecord(result.details);
          if (mutating && details?.status === "running") {
            // A yielded process may still write while later tools run. Without its
            // terminal receipt, a local change cannot be attributed to another command.
            this.hasBackgroundMutation = true;
          }
          if (
            asRecord(result)?.isError === true ||
            details?.status === "error" ||
            details?.status === "timeout"
          ) {
            this.recordFailure(tool.name, callId, args, context);
          } else if (
            candidate &&
            before &&
            exclusive() &&
            this.pending === candidate &&
            details?.status === "completed" &&
            details.exitCode === 0 &&
            details.timedOut !== true &&
            !signal?.aborted
          ) {
            const after = await this.snapshot(candidate);
            if (
              after &&
              after !== before &&
              exclusive() &&
              this.pending === candidate &&
              !signal?.aborted
            ) {
              this.recovered.set(callId, candidate.callId);
              this.pending = undefined;
            }
          }
          const filePath = extractFileTargetPath(tool.name, args);
          if (
            filePath &&
            this.pending?.callId !== callId &&
            resolveToCwd(filePath, context.cwd) === this.pending?.file
          ) {
            // Structured edit/write recovery already clears the warning. Retire its
            // target here too, so subsequent commands do not keep reading that file.
            this.pending = undefined;
          }
          return result;
        } catch (error) {
          this.recordFailure(tool.name, callId, args, context);
          throw error;
        } finally {
          if (mutating) {
            this.activeMutations.delete(callId);
          }
        }
      },
    };
  }

  private recordFailure(toolName: string, callId: string, args: unknown, context: RecoveryContext) {
    const rawPath = extractFileTargetPath(toolName, args);
    this.pending = rawPath
      ? { callId, file: resolveToCwd(rawPath, context.cwd), context }
      : undefined;
  }

  private async snapshot(failure: PendingFileFailure): Promise<string | undefined> {
    // This bounded read is only for an unresolved file failure immediately around
    // a recovery attempt; ordinary tool calls perform no filesystem freshness checks.
    try {
      const root = await fsRoot(failure.context.workspaceDir);
      const relative = path.relative(failure.context.workspaceDir, failure.file);
      const { buffer, realPath } = await root.read(relative, {
        maxBytes: MAX_RECOVERY_BYTES,
        symlinks: "reject",
        hardlinks: "reject",
        nonBlockingRead: true,
      });
      return `${realPath}\0${createHash("sha256").update(buffer).digest("hex")}`;
    } catch {
      // Missing, outside-root, non-regular, unreadable or oversized files supply no proof.
      return undefined;
    }
  }
}
