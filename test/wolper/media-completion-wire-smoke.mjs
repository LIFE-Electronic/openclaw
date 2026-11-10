/** Exercise installed media completion while its requester continues a long turn. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "media-completion-wire-"));
const runtime = process.env.OPENCLAW_PROBE_RUNTIME_ROOT ?? "/app";
const workspace = path.join(root, "workspace");
const plugin = path.join(root, "fixture-provider");
const countFile = path.join(root, "provider-calls");
const continueProvider = path.join(root, "continue-provider");
const flatten = (content) =>
  typeof content === "string" ? content : (content ?? []).map((part) => part.text ?? "").join("\n");
const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let gateway, closed, failure, release;
let logs = "",
  rounds = 0,
  seenCompletion = false,
  finished = false;
const longWork = new Promise((resolve) => {
  release = resolve;
});

const upstream = createServer(async (request, response) => {
  try {
    assert.equal(request.url, "/v1/chat/completions");
    let input = "";
    for await (const chunk of request) {
      input += chunk;
    }
    const body = JSON.parse(input);
    const completion = body.messages.find(
      (message) =>
        message.role === "user" && /session_key: image_generate:/.test(flatten(message.content)),
    );
    let delta,
      finish = "tool_calls";
    const index = rounds++;
    if (completion) {
      const text = flatten(completion.content);
      assert.match(text, /status: completed successfully/);
      assert.doesNotMatch(text, /completion delivery failed/);
      seenCompletion = true;
      // Keep the requester streaming beyond the configured old wake deadline.
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: "Preparing the presentation. " }, finish_reason: null }] })}\n\n`,
      );
      await longWork;
      finished = true;
      delta = { content: "The generated image is ready." };
      finish = "stop";
    } else {
      assert(index < 8, "completion never reached actual model input");
      const name = index === 0 ? "image_generate" : "exec";
      if (index > 0) {
        await fs.writeFile(continueProvider, "requester is busy");
      }
      assert(
        body.tools.some((tool) => tool.function.name === name),
        `missing ${name}`,
      );
      delta = {
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: `media${index}`,
            type: "function",
            function: {
              name,
              arguments: JSON.stringify(
                index === 0
                  ? { prompt: "A castle for the poster" }
                  : { command: "sleep 1", yieldMs: 1000 },
              ),
            },
          },
        ],
      };
      response.writeHead(200, { "content-type": "text/event-stream" });
    }
    response.end(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })}\n\ndata: [DONE]\n\n`,
    );
  } catch (error) {
    failure = error;
    response.writeHead(500);
    response.end("Model fixture assertion failed");
  }
});

function cli(env, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(runtime, "openclaw.mjs"), ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
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
    await delay(100);
  }
  throw new Error(`${description}: ${logs}`);
}

async function messages() {
  const directory = path.join(root, "agents/main/sessions");
  const files = await fs.readdir(directory).catch(() => []);
  const texts = await Promise.all(
    files
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => fs.readFile(path.join(directory, name), "utf8")),
  );
  return texts.flatMap((text) =>
    text
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line).message)
      .filter(Boolean),
  );
}

try {
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(plugin);
  await fs.writeFile(
    path.join(plugin, "package.json"),
    JSON.stringify({
      name: "media-fixture",
      version: "1.0.0",
      type: "module",
      openclaw: { extensions: ["./index.mjs"] },
    }),
  );
  await fs.writeFile(
    path.join(plugin, "openclaw.plugin.json"),
    JSON.stringify({
      id: "media-fixture",
      contracts: { imageGenerationProviders: ["media-fixture"] },
      configSchema: { type: "object", properties: {}, additionalProperties: false },
    }),
  );
  await fs.writeFile(
    path.join(plugin, "index.mjs"),
    `import fs from 'node:fs/promises';
export default { id: 'media-fixture', register(api) {
  api.registerImageGenerationProvider({ id: 'media-fixture', defaultModel: 'fixture', models: ['fixture'], isConfigured: () => true,
    capabilities: { generate: { maxCount: 1 }, edit: { enabled: false } },
    async generateImage() {
      await fs.appendFile(${JSON.stringify(countFile)}, 'call\\n');
      // The image tool yields its initial turn. Complete only once the same
      // requester session has started its long presentation follow-up.
      while (!(await fs.stat(${JSON.stringify(continueProvider)}).catch(() => false))) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      await new Promise(resolve => setTimeout(resolve, 250));
      return { images: [{ buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'), mimeType: 'image/png' }], model: 'fixture' };
    }
  });
} };`,
  );
  await listen(upstream);
  const reservation = createServer();
  await listen(reservation);
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const model = "diagnostic/media-model";
  const configPath = path.join(root, "openclaw.json");
  await fs.writeFile(
    configPath,
    JSON.stringify({
      gateway: {
        mode: "local",
        bind: "loopback",
        port,
        auth: { mode: "token", token: "disposable-media-token" },
        controlUi: { enabled: false },
      },
      plugins: {
        enabled: true,
        allow: ["media-fixture"],
        load: { paths: [plugin] },
        entries: { "media-fixture": { enabled: true } },
      },
      tools: {
        profile: "minimal",
        alsoAllow: ["image_generate", "exec"],
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
                id: "media-model",
                name: "Media model double",
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
          imageGenerationModel: { primary: "media-fixture/fixture" },
          thinkingDefault: "off",
          memorySearch: { enabled: false },
          heartbeat: { every: "0m" },
          subagents: { announceTimeoutMs: 1000 },
        },
      },
    }),
    { mode: 0o600 },
  );
  const env = {
    ...Object.fromEntries(
      ["PATH", "LANG", "LC_ALL", "TMPDIR"].flatMap((key) =>
        process.env[key] ? [[key, process.env[key]]] : [],
      ),
    ),
    OPENCLAW_STATE_DIR: root,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_SKIP_CHANNELS: "1",
    OPENCLAW_GATEWAY_TOKEN: "disposable-media-token",
  };
  gateway = spawn(process.execPath, [path.join(runtime, "openclaw.mjs"), "gateway", "run"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  gateway.stdout.on("data", (chunk) => {
    logs = (logs + chunk).slice(-32000);
  });
  gateway.stderr.on("data", (chunk) => {
    logs = (logs + chunk).slice(-32000);
  });
  closed = new Promise((resolve) => gateway.once("close", resolve));
  await waitFor(async () => {
    try {
      return (await fetch(`http://127.0.0.1:${port}/health`)).ok;
    } catch {
      return false;
    }
  }, "Gateway readiness");
  await cli(env, [
    "gateway",
    "call",
    "agent",
    "--params",
    JSON.stringify({
      message: "Generate a castle image, then prepare a long presentation.",
      sessionKey: "agent:main:main",
      channel: "webchat",
      deliver: false,
      idempotencyKey: "media-probe",
    }),
    "--json",
  ]);
  await waitFor(
    async () =>
      (await messages()).some(
        (message) => message.role === "toolResult" && message.toolName === "image_generate",
      ),
    "Image tool started",
  );
  await cli(env, [
    "gateway",
    "call",
    "agent",
    "--params",
    JSON.stringify({
      message: "Continue preparing the long presentation while the image generates.",
      sessionKey: "agent:main:main",
      channel: "webchat",
      deliver: false,
      idempotencyKey: "presentation-probe",
    }),
    "--json",
  ]);
  await waitFor(() => seenCompletion, "Completion input consumed by busy requester");
  await delay(1500);
  assert.equal(finished, false, "the requester must still be busy beyond the old wake deadline");
  const tasks = await cli(env, ["tasks", "list", "--json"]);
  const nativeTasks = Array.isArray(tasks) ? tasks : tasks.tasks;
  const rows = nativeTasks.filter((task) => task.taskKind === "image_generation");
  assert.equal(rows.length, 1, JSON.stringify(tasks));
  assert.equal(rows[0].status, "succeeded", JSON.stringify(tasks));
  assert.equal(rows[0].deliveryStatus, "delivered", JSON.stringify(tasks));
  assert.equal(
    nativeTasks.find((task) => task.runId === "presentation-probe")?.status,
    "running",
    "requester remains active",
  );
  const publicTasks = await cli(env, [
    "gateway",
    "call",
    "tasks.get",
    "--params",
    JSON.stringify({ taskId: rows[0].taskId }),
    "--json",
  ]);
  assert.equal(publicTasks.task.status, "completed");
  assert(!rows[0].error, JSON.stringify(tasks));
  release();
  await waitFor(
    async () =>
      (await messages()).some(
        (message) =>
          message.role === "assistant" &&
          flatten(message.content).includes("The generated image is ready."),
      ),
    "Requester final reply",
  );
  // Give the independent delivery loop another tick; it must not resend success.
  await delay(5100);
  const transcript = await messages();
  const completions = transcript.filter(
    (message) =>
      message.role === "user" && /session_key: image_generate:/.test(flatten(message.content)),
  );
  assert.equal(completions.length, 1, "one successful completion input");
  assert(
    !transcript.some((message) =>
      /completion delivery failed after successful generation/.test(flatten(message.content)),
    ),
  );
  const finalTasks = await cli(env, ["tasks", "list", "--json"]);
  assert.equal(
    (Array.isArray(finalTasks) ? finalTasks : finalTasks.tasks).find(
      (task) => task.taskKind === "image_generation",
    ).status,
    "succeeded",
  );
  assert.equal(await fs.readFile(countFile, "utf8"), "call\n", "delivery never regenerates media");
  if (failure) {
    throw failure;
  }
  console.log(
    JSON.stringify({
      ok: true,
      busyTaskCompleted: true,
      singleSuccessEvent: true,
      noFalseFailure: true,
      generationCalls: 1,
    }),
  );
} catch (error) {
  throw new Error(
    `Media completion probe failed after ${rounds} model rounds: ${error.message}\n${logs}`,
    { cause: error },
  );
} finally {
  release();
  if (gateway?.exitCode === null) {
    gateway.kill("SIGTERM");
  }
  if (closed) {
    await closed;
  }
  upstream.closeAllConnections();
  await new Promise((resolve) => upstream.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
}
