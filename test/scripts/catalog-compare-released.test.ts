// Catalog Compare Released tests cover the baseline-vs-candidate diff of released reader observations.
import { describe, expect, it } from "vitest";
import {
  diffRuns,
  formatReport,
  type ReleaseRun,
  type RowObservation,
} from "../../scripts/lib/catalog-compare-released-diff.mts";

function kimiRow(highEffort: string): RowObservation {
  const request = (effort: string) => ({
    outcome: "stop",
    calls: [
      {
        method: "POST",
        url: "https://api.moonshot.ai/v1/chat/completions",
        headers: { "content-type": "application/json" },
        body: {
          model: "kimi-k3",
          stream: true,
          reasoning_effort: effort,
          messages: [{ role: "user", content: "hi" }],
        },
      },
    ],
  });
  return {
    model: "moonshot/kimi-k3",
    source: "catalog-row",
    runtimeModel: { id: "kimi-k3", thinkingLevelMap: { low: "low", high: highEffort } },
    profiles: {
      openclaw: { offered: ["low", "high"], default: "low" },
      codex: { offered: ["low", "high"], default: "low" },
    },
    requests: { low: request("low"), high: request(highEffort) },
  };
}

const run = (rows: RowObservation[]): ReleaseRun => ({
  version: "2026.10.8",
  refresh: { status: "updated", generatedAt: 1 },
  rows,
});

describe("catalog compare released diff", () => {
  it("reports nothing for identical observations", () => {
    expect(diffRuns(run([kimiRow("high")]), run([kimiRow("high")]))).toEqual([]);
  });

  it("names each changed field with its level, and listed or dropped rows", () => {
    const other: RowObservation = { ...kimiRow("high"), model: "moonshot/kimi-k2" };
    const changes = diffRuns(run([kimiRow("high"), other]), run([kimiRow("max")]));

    expect(changes.filter((change) => change.model === "moonshot/kimi-k3")).toEqual([
      {
        release: "2026.10.8",
        model: "moonshot/kimi-k3",
        level: "-",
        field: "model.thinkingLevelMap.high",
        before: "high",
        after: "max",
      },
      {
        release: "2026.10.8",
        model: "moonshot/kimi-k3",
        level: "high",
        field: "request.body.reasoning_effort",
        before: "high",
        after: "max",
      },
    ]);
    expect(
      changes.find((change) => change.model === "moonshot/kimi-k2" && change.field === "row"),
    ).toMatchObject({
      before: "listed",
      after: undefined,
    });
    expect(formatReport([{ release: "2026.10.8", label: "latest", changes }]).split("\n")).toEqual([
      `2026.10.8 (latest): ${changes.length} changed fields`,
      `  moonshot/kimi-k2  -  row: "listed" → (absent) (${changes.length - 2} fields)`,
      '  moonshot/kimi-k3  -  model.thinkingLevelMap.high: "high" → "max"',
      '  moonshot/kimi-k3  high  request.body.reasoning_effort: "high" → "max"',
    ]);
  });
});
