/** Real installed Gateway and local model double, isolated from owner sessions. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "wake-prompt-wire-"));
const workspace = path.join(root, "workspace");
const wakes = process.argv[1]
  ? JSON.parse(process.argv[1])
  : [
      '# NEW EVENTS FROM Example\n\nReview the summaries first.\n\n[{"event_id":"wake-1","summary":{"title":"Planning","sender":"Ada"}}]',
      "# NEW BULLETIN ENTRY\n\nRead the durable inbox.\n\nPost ID wake-2.",
      "Administrator notification wake-3. Review the new calendar event.",
    ];
assert(
  Array.isArray(wakes) && wakes.length > 0 && wakes.every((value) => typeof value === "string"),
);
const calls = [];
let activeWake = 0;
let phase = 0;
let gateway;
let closed;
let logs = "";
let failure;
const flatten = (content) =>
  typeof content === "string" ? content : (content ?? []).map((part) => part.text ?? "").join("\n");
const upstream = createServer(async (request, response) => {
  try {
    assert.equal(request.url, "/v1/chat/completions");
    let text = "";
    for await (const chunk of request) {
      text += chunk;
    }
    const body = JSON.parse(text);
    calls.push(body);
    const current = body.messages.findLast((message) => message.role === "user");
    assert(current, "the model must receive the current wake");
    const input = flatten(current.content);
    for (const line of wakes[activeWake].split("\n").filter((value) => value.trim())) {
      assert(input.includes(line), `notification text missing from actual model input: ${line}`);
    }
    assert.notEqual(input.trim(), "[OpenClaw heartbeat poll]");
    let delta;
    let finishReason;
    if (phase++ === 0) {
      assert(body.tools.some((tool) => tool.function.name === "read"));
      delta = {
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: `read-${activeWake}`,
            type: "function",
            function: {
              name: "read",
              arguments: JSON.stringify({ path: path.join(workspace, "details.txt") }),
            },
          },
        ],
      };
      finishReason = "tool_calls";
    } else {
      assert.equal(phase, 2, "unexpected extra model round");
      assert(
        body.messages.some(
          (message) => message.role === "tool" && message.tool_call_id === `read-${activeWake}`,
        ),
      );
      delta = { role: "assistant", content: `Verification round ${activeWake} finished.` };
      finishReason = "stop";
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      "data: " +
        JSON.stringify({
          id: "wake-test",
          object: "chat.completion.chunk",
          created: 0,
          model: body.model,
          choices: [{ index: 0, delta, finish_reason: finishReason }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }) +
        "\n\ndata: [DONE]\n\n",
    );
  } catch (error) {
    failure = error;
    response.writeHead(400);
    response.end("model boundary assertion failed");
  }
});

async function transcript() {
  const directory = path.join(root, "agents/main/sessions");
  const files = await fs.readdir(directory).catch(() => []);
  const rows = [];
  for (const file of files.filter((name) => name.endsWith(".jsonl"))) {
    const lines = (await fs.readFile(path.join(directory, file), "utf8")).split("\n");
    for (const line of lines.filter(Boolean)) {
      try {
        rows.push(JSON.parse(line));
      } catch {
        /* A concurrent final append can be partial. */
      }
    }
  }
  return rows.map((row) => row.message).filter(Boolean);
}

try {
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const reservation = createServer();
  await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const gatewayPort = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(
    path.join(workspace, "HEARTBEAT.md"),
    "Handle the queued event. Use read for details when helpful.\n",
  );
  await fs.writeFile(path.join(workspace, "details.txt"), "Read-only verification detail.\n");
  const model = "diagnostic/deepseek-v4.1-flash";
  const config = {
    gateway: {
      mode: "local",
      bind: "loopback",
      port: gatewayPort,
      auth: { mode: "token", token: "disposable-gateway-token" },
      controlUi: { enabled: false },
    },
    hooks: { enabled: true, path: "/hooks", token: "disposable-wake-token" },
    plugins: { enabled: false },
    cron: { enabled: false },
    tools: { profile: "minimal", alsoAllow: ["read"] },
    models: {
      providers: {
        diagnostic: {
          baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`,
          api: "openai-completions",
          apiKey: "dummy",
          models: [
            {
              id: "deepseek-v4.1-flash",
              name: "Model double",
              reasoning: false,
              input: ["text"],
              contextWindow: 131072,
              maxTokens: 4096,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              compat: { maxTokensField: "max_tokens" },
            },
          ],
        },
      },
    },
    agents: {
      defaults: {
        workspace,
        model,
        thinkingDefault: "off",
        memorySearch: { enabled: false },
        heartbeat: { every: "12h", model, target: "none", session: "agent:main:main" },
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
  gateway = spawn(process.execPath, ["/app/openclaw.mjs", "gateway", "run"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  gateway.stdout.on("data", (chunk) => {
    logs = (logs + chunk).slice(-32000);
  });
  gateway.stderr.on("data", (chunk) => {
    logs = (logs + chunk).slice(-32000);
  });
  closed = new Promise((resolve) => gateway.on("exit", resolve));
  let ready = false;
  for (let attempt = 0; attempt < 300 && !ready; attempt++) {
    assert.equal(gateway.exitCode, null, logs);
    try {
      ready = (await fetch(`http://127.0.0.1:${gatewayPort}/health`)).ok;
    } catch {
      /* Wait for this disposable Gateway. */
    }
    if (!ready) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  assert(ready, `Gateway did not become healthy: ${logs}`);
  for (activeWake = 0; activeWake < wakes.length; activeWake++) {
    phase = 0;
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/hooks/wake`, {
      method: "POST",
      headers: {
        authorization: "Bearer disposable-wake-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ text: wakes[activeWake], mode: "now" }),
    });
    assert(response.ok, await response.text());
    let finished = false;
    for (let attempt = 0; attempt < 300 && !finished; attempt++) {
      if (failure) {
        throw failure;
      }
      assert.equal(gateway.exitCode, null, logs);
      finished = (await transcript()).some(
        (message) =>
          message.role === "assistant" &&
          flatten(message.content).includes(`Verification round ${activeWake} finished.`),
      );
      if (!finished) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    assert(finished, `Wake did not finish: ${logs}`);
  }
  const userMessages = (await transcript()).filter((message) => message.role === "user");
  assert.equal(userMessages.length, wakes.length);
  assert(userMessages.every((message) => flatten(message.content) === "[OpenClaw heartbeat poll]"));
  assert.equal(calls.length, wakes.length * 2);
  console.log(
    JSON.stringify({
      ok: true,
      wirePrompt: true,
      toolRound: true,
      transcriptMarker: true,
      noPromptHook: true,
      notifications: wakes.length,
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
