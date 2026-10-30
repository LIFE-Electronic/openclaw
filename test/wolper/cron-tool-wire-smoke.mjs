// Entirely disposable native Gateway + HTTP model double. No owner agent or paid API.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "wolper-cron-wire-"));
const calls = [];
let gateway;
let closed;
let logs = "";
let failure;
const correct = {
  action: "add",
  job: {
    name: "Disposable cron repair",
    enabled: false,
    schedule: { kind: "every", everyMs: 600000 },
    sessionTarget: "isolated",
    payload: { kind: "agentTurn", message: "Send the requested reminder." },
    delivery: { mode: "bluehouse", to: "agent:main:main" },
  },
};
const upstream = createServer(async (request, response) => {
  try {
    assert.equal(request.url, "/v1/chat/completions");
    let text = "";
    for await (const chunk of request) {
      text += chunk;
    }
    const body = JSON.parse(text);
    const cron = body.tools.find((tool) => tool.function.name === "cron").function;
    assert.deepEqual(
      [...cron.parameters.properties.job.required].toSorted((a, b) => a.localeCompare(b)),
      ["name", "payload", "schedule", "sessionTarget"],
    );
    assert.equal(cron.parameters.properties.job.additionalProperties, false);
    calls.push(body);
    let delta;
    let finish = "tool_calls";
    if (calls.length === 1) {
      delta = {
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: "invalidcron",
            type: "function",
            function: {
              name: "cron",
              arguments: JSON.stringify({
                action: "add",
                job: { name: "Bad reminder", scheduleNested: { kind: "every", everyMs: 600000 } },
              }),
            },
          },
        ],
      };
    } else if (calls.length === 2) {
      const error = body.messages.find(
        (message) => message.role === "tool" && message.tool_call_id === "invalidcron",
      );
      assert(
        error,
        "validation result must remain linked to the rejected call: " +
          JSON.stringify(
            body.messages.map((message) => ({
              role: message.role,
              tool_call_id: message.tool_call_id,
              tool_calls: message.tool_calls?.map((call) => ({
                id: call.id,
                name: call.function?.name,
              })),
              ...(message.role === "tool" ? { content: message.content } : {}),
            })),
          ),
      );
      assert(error.content.includes("job.scheduleNested"), error.content);
      assert(error.content.includes("job.schedule"), error.content);
      assert(error.content.includes("Example cron call:"), error.content);
      delta = {
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: "validcron",
            type: "function",
            function: { name: "cron", arguments: JSON.stringify(correct) },
          },
        ],
      };
    } else {
      assert.equal(calls.length, 3, "unexpected additional model request");
      const receipt = body.messages.find(
        (message) => message.role === "tool" && message.tool_call_id === "validcron",
      );
      assert(receipt);
      assert.equal(JSON.parse(receipt.content).name, correct.job.name, receipt.content);
      delta = { role: "assistant", content: "Cron tool repair verified." };
      finish = "stop";
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      "data: " +
        JSON.stringify({
          id: "mock",
          object: "chat.completion.chunk",
          created: 0,
          model: body.model,
          choices: [{ index: 0, delta, finish_reason: finish }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }) +
        "\n\ndata: [DONE]\n\n",
    );
  } catch (error) {
    failure = error;
    response.writeHead(400);
    response.end("mock assertion failed");
  }
});
await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
const reservation = createServer();
await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
const gatewayPort = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
const config = {
  gateway: {
    mode: "local",
    bind: "loopback",
    port: gatewayPort,
    auth: { mode: "token", token: "disposable-test-token" },
    controlUi: { enabled: false },
  },
  cron: { enabled: false },
  tools: { profile: "minimal", alsoAllow: ["cron"] },
  models: {
    providers: {
      diagnostic: {
        baseUrl: "http://127.0.0.1:" + upstream.address().port + "/v1",
        api: "openai-completions",
        apiKey: "dummy",
        models: [
          {
            id: "deepseek-v4.1-flash",
            name: "Disposable model double",
            reasoning: true,
            input: ["text"],
            contextWindow: 1048576,
            maxTokens: 4096,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            compat: { supportsReasoningEffort: true, maxTokensField: "max_tokens" },
          },
        ],
      },
    },
  },
  agents: {
    defaults: {
      workspace: path.join(root, "workspace"),
      model: "diagnostic/deepseek-v4.1-flash",
      thinkingDefault: "off",
      memorySearch: { enabled: false },
    },
  },
};
const configPath = path.join(root, "openclaw.json");
await fs.writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
const env = {
  ...process.env,
  OPENCLAW_STATE_DIR: root,
  OPENCLAW_CONFIG_PATH: configPath,
  OPENCLAW_SKIP_CHANNELS: "1",
};
const run = (args) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["/app/openclaw.mjs", ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
const rpc = async (method, params) => {
  const result = await run([
    "gateway",
    "call",
    method,
    "--json",
    "--params",
    JSON.stringify(params),
  ]);
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout);
};
try {
  gateway = spawn(process.execPath, ["/app/openclaw.mjs", "gateway", "run"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  gateway.stdout.on("data", (chunk) => (logs = (logs + chunk).slice(-32000)));
  gateway.stderr.on("data", (chunk) => (logs = (logs + chunk).slice(-32000)));
  closed = new Promise((resolve) => gateway.on("exit", resolve));
  let ready = false;
  for (let attempt = 0; attempt < 300 && !ready; attempt++) {
    assert.equal(gateway.exitCode, null, logs);
    try {
      ready = (await fetch("http://127.0.0.1:" + gatewayPort + "/health")).ok;
    } catch {}
    if (!ready) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  assert(ready, "Disposable Gateway was not healthy: " + logs);
  const result = await run([
    "agent",
    "--agent",
    "main",
    "--message",
    "Set up a disabled reminder for this diagnostic.",
    "--json",
  ]);
  if (failure) {
    throw failure;
  }
  assert.equal(result.code, 0, result.stderr + logs);
  assert.equal(calls.length, 3, result.stdout + logs);
  // Grant only this disposable CLI device the backend's operator scope, so the
  // cleanup call does not require an interactive device-scope approval.
  const pairedPath = path.join(root, "devices/paired.json");
  const paired = JSON.parse(await fs.readFile(pairedPath, "utf8"));
  const scopes = [
    "operator.admin",
    "operator.read",
    "operator.write",
    "operator.approvals",
    "operator.pairing",
  ];
  for (const device of Object.values(paired)) {
    device.scopes = scopes;
    device.approvedScopes = scopes;
    if (device.tokens?.operator) {
      device.tokens.operator.scopes = scopes;
    }
  }
  await fs.writeFile(pairedPath, JSON.stringify(paired), { mode: 0o600 });
  const inventory = await rpc("cron.list", { includeDisabled: true });
  assert.equal(inventory.jobs.length, 1);
  const job = inventory.jobs[0];
  for (const key of ["name", "enabled", "sessionTarget", "payload", "delivery"]) {
    assert.deepEqual(job[key], correct.job[key]);
  }
  assert.equal(job.schedule.kind, "every");
  assert.equal(job.schedule.everyMs, 600000);
  await rpc("cron.remove", { id: job.id });
  assert.equal((await rpc("cron.list", { includeDisabled: true })).jobs.length, 0);
  console.log(
    JSON.stringify({
      ok: true,
      wireSchema: true,
      errorReturnedToModel: true,
      repairedCallPersisted: true,
      testJobRemoved: true,
    }),
  );
} finally {
  if (gateway && gateway.exitCode === null) {
    gateway.kill("SIGTERM");
  }
  if (closed) {
    await closed;
  }
  upstream.closeAllConnections();
  await new Promise((resolve) => upstream.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
}
