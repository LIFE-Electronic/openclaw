/** Model-visible repair guidance shared by local and Gateway cron validation. */
export const CRON_ADD_EXAMPLE = {
  action: "add",
  job: {
    name: "Reminder",
    schedule: { kind: "every", everyMs: 600000 },
    sessionTarget: "isolated",
    payload: { kind: "agentTurn", message: "Send the requested reminder." },
  },
};

type CronValidationIssue = {
  keyword?: string;
  instancePath?: string;
  params?: Record<string, unknown>;
  message?: string;
};

function repairExample(): string {
  return `Use the documented nested fields; do not invent flattened aliases.\nExample cron call:\n${JSON.stringify(CRON_ADD_EXAMPLE, null, 2)}`;
}

function propertyNames(value: unknown): string[] {
  return typeof value === "string"
    ? [value]
    : Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
}

/** Prefix scheduler paths with job so the model can repair its tool envelope. */
export function cronAddValidationMessage(
  issues: readonly CronValidationIssue[] | null | undefined,
): string {
  const lines = (issues ?? []).flatMap((issue) => {
    const path = "job" + (issue.instancePath ?? "").replaceAll("/", ".");
    const params = issue.params ?? {};
    if (issue.keyword === "required") {
      return propertyNames(params.missingProperty ?? params.requiredProperties).map(
        (name) => `${path}.${name}: required`,
      );
    }
    if (issue.keyword === "additionalProperties") {
      return propertyNames(params.additionalProperty ?? params.additionalProperties).map(
        (name) => `${path}.${name}: unknown field`,
      );
    }
    return [`${path}: ${issue.message ?? "invalid value"}`];
  });
  // Union validators can repeat errors; retain distinct actionable paths once.
  const details = [...new Set(lines)].slice(0, 16).join("\n");
  return `Invalid cron.add arguments:\n${details || "job: invalid job object"}\n\n${repairExample()}`;
}

/** Keep the Gateway's reason, but disambiguate its inner-object path names. */
export function cronAddGatewayValidationMessage(message: string): string {
  return `${message}\nGateway validation paths (including root) are relative to job.\n\n${repairExample()}`;
}
