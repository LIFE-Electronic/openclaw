import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { resolveStateDir } from "../../config/paths.js";
import { materializeBackgroundResult } from "../../infra/wolper-background-runtime.js";
import {
  ackBackgroundResult,
  backgroundDeliveryStatus,
  pendingBackgroundResults,
  type BackgroundReceipt,
} from "../../infra/wolper-background.js";
import { copyIntoSession } from "../../infra/wolper-message-copy-runtime.js";
import { copyRequestSchema, CopyConflictError } from "../../infra/wolper-message-copy.js";
import type { GatewayRequestHandlers } from "./types.js";

export const wolperBackgroundHandlers: GatewayRequestHandlers = {
  "wolper.messages.copy": async ({ params, client, respond, context }) => {
    const parsed = copyRequestSchema.safeParse(params);
    if (client?.connect.client.mode !== "backend" || !parsed.success) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "A valid backend copy request is required"),
      );
      return;
    }
    try {
      const receipt = await copyIntoSession(parsed.data);
      if (receipt.status === "committed") {
        // Publish only after both the transcript and durable receipt are stored.
        context.broadcast("wolper.message.copied", receipt);
      }
      context.logGateway.info("Native background copy handled", {
        copyId: parsed.data.copyId,
        status: receipt.status,
      });
      respond(true, receipt);
    } catch (error) {
      context.logGateway.error("Native background copy failed", { copyId: parsed.data.copyId });
      respond(
        false,
        undefined,
        error instanceof CopyConflictError
          ? errorShape(ErrorCodes.INVALID_REQUEST, "Native copy conflict")
          : errorShape(ErrorCodes.UNAVAILABLE, "Native copy could not be committed"),
      );
    }
  },
  "wolper.deliveries.status": async ({ params, respond }) => {
    if (
      typeof params.executionId !== "string" ||
      typeof params.destinationSessionKey !== "string"
    ) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "Execution and destination are required"),
      );
      return;
    }
    respond(
      true,
      await backgroundDeliveryStatus(
        resolveStateDir(),
        params.executionId,
        params.destinationSessionKey,
      ),
    );
  },
  "wolper.deliveries.pending": async ({ params, respond, context }) => {
    try {
      const page = await pendingBackgroundResults(resolveStateDir(), {
        limit:
          typeof params.limit === "number" && Number.isInteger(params.limit) ? params.limit : 50,
        after: typeof params.after === "string" ? params.after : undefined,
      });
      // The native conversation must contain the result without another model turn.
      const entries = [];
      for (const entry of page.entries) {
        try {
          await materializeBackgroundResult(entry);
          entries.push(entry);
        } catch {
          context.logGateway.error("Native background materialization will retry", {
            runId: entry.executionId,
          });
        }
      }
      respond(true, { ...page, entries });
    } catch {
      context.logGateway.error("Native pending background read failed");
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          "Pending background delivery is temporarily unavailable",
        ),
      );
    }
  },
  "wolper.deliveries.ack": async ({ params, client, respond, context }) => {
    if (client?.connect.client.mode !== "backend") {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "Only the backend may acknowledge a committed delivery",
        ),
      );
      return;
    }
    if (
      typeof params.execution_id !== "string" ||
      typeof params.destination_session_key !== "string" ||
      !["delivered", "suppressed", "cancelled"].includes(String(params.status)) ||
      (params.row_id !== null && typeof params.row_id !== "string")
    ) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "Invalid background receipt"),
      );
      return;
    }
    try {
      await ackBackgroundResult(resolveStateDir(), params as BackgroundReceipt);
      context.logGateway.info("Background receipt committed", {
        runId: params.execution_id,
        status: params.status,
      });
      respond(true, { ok: true });
    } catch {
      context.logGateway.error("Background receipt rejected", { runId: params.execution_id });
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "Background receipt could not be accepted"),
      );
    }
  },
};
