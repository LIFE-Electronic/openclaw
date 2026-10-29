import assert from "node:assert/strict";
import fs from "node:fs/promises";

// Discover bundled exports by function identity, not unstable build filenames.
async function installedCronExport(name) {
  for (const file of await fs.readdir("/app/dist")) {
    if (!file.endsWith(".js")) {
      continue;
    }
    const source = await fs.readFile("/app/dist/" + file, "utf8");
    if (!source.includes("function " + name + "(")) {
      continue;
    }
    // The adapter is private in the bundle. Its metadata projection only needs
    // these two pure dependencies; never execute the extracted tool wrapper.
    if (name === "toToolDefinitions") {
      const start = source.indexOf("function " + name + "(");
      const end = source.indexOf("\nfunction ", start + 1);
      assert(end > start, "bounded compiled adapter function");
      // Execute only repository-owned source extracted for this contract probe.
      // oxlint-disable-next-line typescript/no-implied-eval
      return new Function(
        "normalizeToolName",
        "isToolWrappedWithBeforeToolCallHook",
        source.slice(start, end) + "\nreturn toToolDefinitions;",
      )(
        (name) => name,
        () => false,
      );
    }
    const module = await import("/app/dist/" + file);
    const fn = Object.values(module).find(
      (value) => typeof value === "function" && value.name === name,
    );
    if (fn) {
      return fn;
    }
  }
  throw new Error("Installed cron contract export unavailable: " + name);
}

// Read-only: construct tools and reject malformed arguments before any RPC.
async function verifyCronToolContract() {
  const createTools = await installedCronExport("createOpenClawTools");
  const adapt = await installedCronExport("toToolDefinitions");
  const tool = createTools({
    config: {},
    agentSessionKey: "agent:main:main",
    agentChannel: "webchat",
    disablePluginTools: true,
  }).find((tool) => tool.name === "cron");
  assert(tool);
  const job = tool.parameters.properties.job;
  assert.deepEqual(
    [...job.required].toSorted((a, b) => a.localeCompare(b)),
    ["name", "payload", "schedule", "sessionTarget"],
  );
  assert.equal(job.additionalProperties, false);
  for (const [field, discriminant] of [
    ["schedule", "kind"],
    ["payload", "kind"],
    ["delivery", "mode"],
  ]) {
    assert.equal(job.properties[field].additionalProperties, false, field);
    assert(job.properties[field].required.includes(discriminant), field);
  }
  assert.equal(tool.parameters.properties.patch.required?.length ?? 0, 0);
  assert.equal(tool.parameters.properties.patch.properties.payload.required?.length ?? 0, 0);
  const definition = adapt([tool])[0];
  assert.equal(typeof definition.prepareArguments, "function");
  const valid = {
    action: "add",
    job: {
      name: "Contract reminder",
      schedule: { kind: "every", everyMs: 600000 },
      sessionTarget: "isolated",
      payload: { kind: "agentTurn", message: "Send the requested reminder." },
      delivery: { mode: "bluehouse", to: "agent:main:main" },
    },
  };
  const prepared = definition.prepareArguments(structuredClone(valid));
  for (const key of ["name", "schedule", "sessionTarget", "payload", "delivery"]) {
    assert.deepEqual(prepared.job[key], valid.job[key]);
  }
  assert.deepEqual(
    definition.prepareArguments(prepared),
    prepared,
    "normalization must be idempotent",
  );
  const inferredDelivery = structuredClone(valid);
  delete inferredDelivery.job.delivery;
  assert.equal(
    definition.prepareArguments(inferredDelivery).job.delivery,
    undefined,
    "normalization must leave default delivery to the channel-aware execution path",
  );
  for (const field of ["scheduleEnd", "scheduleNested", "sessionTarget_kind"]) {
    const invalid = { action: "add", job: { name: "Invalid reminder", [field]: 600000 } };
    assert.throws(
      () => definition.prepareArguments(invalid),
      (error) => {
        assert(error.message.includes("job." + field));
        assert(error.message.includes("job.schedule"));
        const example = JSON.parse(error.message.split("Example cron call:\n")[1]);
        assert.equal(example.action, "add");
        assert.doesNotThrow(() => definition.prepareArguments(example));
        return true;
      },
    );
    await assert.rejects(tool.execute("contract-invalid", invalid), /Example cron call:/);
  }
  for (const params of [
    { action: "list" },
    { action: "update", jobId: "existing", patch: { payload: { message: "Revised reminder" } } },
  ]) {
    assert.deepEqual(definition.prepareArguments(params), params);
  }
  return {
    ok: true,
    creationSchema: true,
    partialUpdates: true,
    actionableErrors: true,
    argumentHook: true,
  };
}
