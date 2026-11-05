/** Real tool retries and final delivery in an isolated installed Gateway. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "file-recovery-wire-"));
const runtime = process.env.OPENCLAW_PROBE_RUNTIME_ROOT ?? "/app";
const flatten = (content) =>
  typeof content === "string" ? content : (content ?? []).map((part) => part.text ?? "").join("\n");
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let current;
let phase = 0;
let failure;
let gateway;
let closed;
let logs = "";

const upstream = createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ object: "list", data: [{ id: "recovery-model", object: "model" }] }),
      );
      return;
    }
    assert.equal(request.url, "/v1/chat/completions");
    let input = "";
    for await (const chunk of request) {
      input += chunk;
    }
    const body = JSON.parse(input);
    const index = phase++;
    let delta;
    let finishReason = "tool_calls";
    const file = path.join(current.workspace, "state.json");
    if (index < 3) {
      const toolName = index < 2 ? "edit" : "exec";
      assert(body.tools.some((tool) => tool.function.name === toolName));
      if (index > 0) {
        const previous = body.messages.findLast((message) => message.role === "tool");
        assert(previous, "the model must receive the failed edit result");
        assert.match(
          flatten(previous.content),
          index === 1 ? /Could not find/i : /No changes made/i,
        );
      }
      const python =
        "import json,pathlib; p=pathlib.Path(" +
        JSON.stringify(file) +
        '); data=json.loads(p.read_text()); data["ids"].append("third"); p.write_text(json.dumps(data))';
      const args =
        index < 2
          ? {
              path: file,
              edits: [
                {
                  oldText: index === 0 ? "missing-id" : "second",
                  newText: index === 0 ? "third" : "second",
                },
              ],
            }
          : {
              command: current.recovered
                ? `UV_CACHE_DIR=/tmp/uv-cache uv run --no-project python -c ${quote(python)}`
                : "true",
              yieldMs: 10000,
            };
      delta = {
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: `recovery${index}`,
            type: "function",
            function: { name: toolName, arguments: JSON.stringify(args) },
          },
        ],
      };
    } else {
      assert.equal(index, 3, "unexpected extra model turn");
      const ids = JSON.parse(await fs.readFile(file, "utf8")).ids;
      assert.deepEqual(ids, current.recovered ? ["first", "second", "third"] : ["first", "second"]);
      delta = {
        role: "assistant",
        content: current.mode === "heartbeat" ? "HEARTBEAT_OK" : "Recovery completed.",
      };
      finishReason = "stop";
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      `data: ${JSON.stringify({ id: "recovery-probe", choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finishReason }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })}\n\ndata: [DONE]\n\n`,
    );
  } catch (error) {
    failure = error;
    response.writeHead(500);
    response.end("Model fixture assertion failed");
  }
});

async function waitFor(check, description) {
  for (let attempt = 0; attempt < 600; attempt++) {
    if (failure) {
      throw failure;
    }
    assert.equal(gateway.exitCode, null, logs);
    const result = await check();
    if (result) {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${description}: ${logs}`);
}

async function records(directory) {
  const files = await fs.readdir(directory).catch((error) => {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  });
  return Promise.all(
    files
      .filter((file) => file.endsWith(".json"))
      .map(async (file) => JSON.parse(await fs.readFile(path.join(directory, file), "utf8"))),
  );
}

function cli(env, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(runtime, "openclaw.mjs"), ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) {
        return reject(new Error(stderr + stdout));
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`Invalid CLI JSON: ${stdout}`, { cause: error }));
      }
    });
  });
}

try {
  await listen(upstream);
  for (const [mode, recovered] of [
    ["chat", true],
    ["heartbeat", true],
    ["cron", true],
    ["heartbeat", false],
  ]) {
    const state = path.join(root, `${mode}-${recovered}`);
    const workspace = path.join(state, "workspace");
    current = { mode, recovered, workspace };
    phase = 0;
    logs = "";
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(path.join(workspace, "state.json"), '{"ids":["first","second"]}');
    await fs.writeFile(path.join(workspace, "HEARTBEAT.md"), "Check and update the state file.\n");
    const reservation = createServer();
    await listen(reservation);
    const port = reservation.address().port;
    await new Promise((resolve) => reservation.close(resolve));
    const model = "diagnostic/recovery-model";
    const config = {
      gateway: {
        mode: "local",
        bind: "loopback",
        port,
        auth: { mode: "token", token: "disposable-recovery-token" },
        controlUi: { enabled: false },
      },
      hooks: { enabled: true, path: "/hooks", token: "disposable-hook-token" },
      plugins: { enabled: false },
      cron: { enabled: true },
      tools: {
        profile: "minimal",
        alsoAllow: ["edit", "exec"],
        exec: { host: "gateway", security: "full", ask: "off" },
      },
      models: {
        providers: {
          diagnostic: {
            baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`,
            api: "openai-completions",
            apiKey: "dummy",
            models: [
              {
                id: "recovery-model",
                name: "Recovery model double",
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
          heartbeat: { every: "12h", model, target: "bluehouse", session: "agent:main:main" },
        },
      },
    };
    const configPath = path.join(state, "openclaw.json");
    await fs.writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
    const shellEnv = Object.fromEntries(
      ["PATH", "LANG", "LC_ALL", "TMPDIR"].flatMap((key) =>
        process.env[key] ? [[key, process.env[key]]] : [],
      ),
    );
    const env = {
      ...shellEnv,
      OPENCLAW_STATE_DIR: state,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_GATEWAY_TOKEN: "disposable-recovery-token",
    };
    gateway = spawn(process.execPath, [path.join(runtime, "openclaw.mjs"), "gateway", "run"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    gateway.stdout.on("data", (chunk) => (logs = (logs + chunk).slice(-32000)));
    gateway.stderr.on("data", (chunk) => (logs = (logs + chunk).slice(-32000)));
    closed = new Promise((resolve) => gateway.once("close", resolve));
    await waitFor(async () => {
      try {
        return (await fetch(`http://127.0.0.1:${port}/health`)).ok;
      } catch {
        return false;
      }
    }, "Gateway readiness");
    const rpc = (method, params) =>
      cli(env, ["gateway", "call", method, "--params", JSON.stringify(params), "--json"]);
    let chat;
    let job;
    if (mode === "chat") {
      chat = await cli(env, [
        "agent",
        "--agent",
        "main",
        "--message",
        "Update the state file.",
        "--json",
      ]);
    } else if (mode === "heartbeat") {
      const response = await fetch(`http://127.0.0.1:${port}/hooks/wake`, {
        method: "POST",
        headers: {
          authorization: "Bearer disposable-hook-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ text: "Update the state file.", mode: "now" }),
      });
      assert(response.ok, await response.text());
    } else {
      job = await rpc("cron.add", {
        name: "Recovery proof",
        enabled: false,
        schedule: { kind: "every", everyMs: 86400000 },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: "Update the state file.", model },
        delivery: { mode: "bluehouse", to: "agent:main:main" },
      });
      const started = await rpc("cron.run", { id: job.id, mode: "force" });
      assert(started.ok, JSON.stringify(started));
    }
    if (mode === "chat") {
      const payloads = chat.result?.payloads ?? chat.payloads;
      assert(Array.isArray(payloads), JSON.stringify(chat));
      assert(payloads.some((payload) => payload.text === "Recovery completed."));
      assert(
        payloads.every((payload) => !payload.isError && !/failed/i.test(payload.text ?? "")),
        JSON.stringify(payloads),
      );
    } else {
      const queued = await waitFor(
        async () =>
          (await records(path.join(state, "wolper-background/pending"))).find(
            (entry) => entry.result?.origin.trigger === mode,
          ),
        "Background outcome",
      );
      assert.equal(
        queued.result.outcome,
        recovered ? "completed" : "failed",
        JSON.stringify(queued),
      );
      const content = flatten(queued.result.message.content);
      if (mode === "heartbeat" && recovered) {
        assert.equal(content, "HEARTBEAT_OK");
      } else if (recovered) {
        assert.equal(content, "Recovery completed.");
      } else {
        assert.match(content, /Scheduled task failed/);
      }
      if (job) {
        const runs = await rpc("cron.runs", { id: job.id, limit: 1 });
        assert.equal(runs.entries[0].status, "ok", JSON.stringify(runs));
      }
    }
    assert.equal(phase, 4, "all four model rounds must run");
    if (failure) {
      throw failure;
    }
    gateway.kill("SIGTERM");
    await closed;
    gateway = undefined;
    closed = undefined;
    const sessionDir = path.join(state, "agents/main/sessions");
    const transcriptFiles = (await fs.readdir(sessionDir)).filter((file) =>
      file.endsWith(".jsonl"),
    );
    const messages = (
      await Promise.all(
        transcriptFiles.map((file) => fs.readFile(path.join(sessionDir, file), "utf8")),
      )
    ).flatMap((text) =>
      text
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).message)
        .filter(Boolean),
    );
    assert.equal(
      messages.filter((message) => message.role === "toolResult" && message.isError).length,
      2,
      "failed attempts remain in the transcript",
    );
  }
  console.log(
    JSON.stringify({
      ok: true,
      chatRecovery: true,
      heartbeatRecovery: true,
      cronRecovery: true,
      unresolvedFailure: true,
      diagnosticErrorsRetained: true,
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
