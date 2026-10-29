// Show how a candidate model-catalog bundle changes behavior for released OpenClaw installs.
// A developer report, not a gate: it always exits 0 once every release was compared.
// See the "Model Listing" rules in src/plugins/AGENTS.md.
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs, promisify } from "node:util";
import {
  diffRuns,
  formatReport,
  type Change,
  type ReleaseRun,
} from "./lib/catalog-compare-released-diff.mts";

const run = promisify(execFile);
const SERVED_CATALOG_URL = "https://catalog.openclaw.ai/models/v2/catalog.json";
const DIST_TAGS = ["latest", "extended-stable", "beta"];
const CACHE_ROOT = path.join(os.tmpdir(), "openclaw-catalog-compare-released");
const WORKER = path.join(import.meta.dirname, "lib/catalog-compare-released-worker.mts");

const { values } = parseArgs({
  options: {
    candidate: { type: "string" },
    baseline: { type: "string" },
    releases: { type: "string" },
    filter: { type: "string" },
    json: { type: "boolean", default: false },
    dump: { type: "string" },
  },
});
if (!values.candidate) {
  console.error(
    "usage: pnpm catalog:compare-released --candidate <bundle.json> [--baseline <bundle.json>] [--releases <v,v>] [--filter <provider[/model]>] [--json] [--dump <dir>]",
  );
  process.exit(2);
}

async function npm(args: string[], cwd?: string): Promise<string> {
  return (await run("npm", args, { cwd, maxBuffer: 64 * 1024 * 1024 })).stdout;
}

async function releaseVersions(): Promise<Array<{ version: string; label: string }>> {
  if (values.releases) {
    return values.releases
      .split(",")
      .map((version) => ({ version: version.trim(), label: "requested" }));
  }
  // Under pnpm, npm runs in workspace mode and wraps the answer in a one-entry array.
  const parsed = JSON.parse(await npm(["view", "openclaw", "dist-tags", "--json"])) as
    | Record<string, string>
    | Array<Record<string, string>>;
  const tags = Array.isArray(parsed) ? (parsed[0] ?? {}) : parsed;
  if (!DIST_TAGS.some((tag) => tags[tag])) {
    throw new Error("npm returned no openclaw dist-tags; pass --releases");
  }
  const byVersion = new Map<string, string[]>();
  for (const tag of DIST_TAGS) {
    if (tags[tag]) {
      byVersion.set(tags[tag], [...(byVersion.get(tags[tag]) ?? []), tag]);
    }
  }
  return [...byVersion].map(([version, labels]) => ({ version, label: labels.join(", ") }));
}

// openclaw@<v> plus every official external provider plugin at the same version,
// as the release itself lists them. Cached across runs; scripts never run.
async function installRelease(version: string): Promise<string> {
  const dir = path.join(CACHE_ROOT, version);
  if (fs.existsSync(path.join(dir, ".installed"))) {
    return dir;
  }
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), '{ "private": true }\n');
  const install = ["install", "--ignore-scripts", "--no-audit", "--no-fund"];
  await npm([...install, `openclaw@${version}`], dir);
  const dist = path.join(dir, "node_modules/openclaw/dist");
  const listing = fs
    .readdirSync(dist)
    .map((file) => path.join(dist, file))
    .find(
      (file) =>
        file.endsWith(".mjs") &&
        fs.readFileSync(file, "utf8").includes("official-external-provider-catalog.json"),
    );
  if (!listing) {
    throw new Error(`openclaw@${version}: official external provider catalog not found in ${dist}`);
  }
  const names = [
    ...new Set(
      [
        ...fs.readFileSync(listing, "utf8").matchAll(/"npmSpec": "(@openclaw\/[\w.-]+-provider)"/g),
      ].map((match) => match[1]),
    ),
  ];
  const plugins = (
    await Promise.all(
      names.map((name) =>
        npm(["view", `${name}@${version}`, "version"]).then(
          (out) => (out.trim() ? [name] : []),
          () => [],
        ),
      ),
    )
  ).flat();
  await npm([...install, ...plugins.map((name) => `${name}@${version}`)], dir);
  const missing = names.filter((name) => !plugins.includes(name));
  fs.writeFileSync(path.join(dir, ".installed"), JSON.stringify({ plugins, missing }, null, 2));
  return dir;
}

async function selfSignedCert(dir: string): Promise<{ cert: string; key: string }> {
  const cert = path.join(dir, "upstream-cert.pem");
  const key = path.join(dir, "upstream-key.pem");
  await run("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-subj",
    "/CN=catalog-compare-upstream",
    "-keyout",
    key,
    "-out",
    cert,
  ]);
  return { cert, key };
}

// Each reader process gets its own HOME, state and working directory: released code
// must never open the user's ~/.openclaw state, reach a running Gateway, or load
// workspace plugins from this checkout.
async function readRelease(
  label: "baseline" | "candidate",
  releaseDir: string,
  bundle: string,
  comparedBundles: string[],
  runDir: string,
  cert: { cert: string; key: string },
): Promise<ReleaseRun> {
  const sandbox = fs.mkdtempSync(path.join(runDir, "sandbox-"));
  for (const sub of ["home", "state", "tmp", "workspace"]) {
    fs.mkdirSync(path.join(sandbox, sub));
  }
  const out = path.join(sandbox, "run.json");
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: path.join(sandbox, "home"),
    OPENCLAW_HOME: path.join(sandbox, "home"),
    OPENCLAW_STATE_DIR: path.join(sandbox, "state"),
    OPENCLAW_CONFIG_PATH: path.join(sandbox, "state/openclaw.json"),
    TMPDIR: path.join(sandbox, "tmp"),
  };
  // Released code finds bundled plugins relative to its entry script; a worker
  // inside this checkout would make it load the checkout's extensions/.
  const worker = path.join(runDir, path.basename(WORKER));
  fs.copyFileSync(WORKER, worker);
  const workerArgs = JSON.stringify({
    releaseDir,
    bundle,
    comparedBundles,
    sandbox,
    out,
    filter: values.filter,
    ...cert,
  });
  const log: Buffer[] = [];
  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(process.execPath, [worker, workerArgs], {
      cwd: path.join(sandbox, "workspace"),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk: Buffer) => log.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => log.push(chunk));
    child.on("error", reject);
    child.on("close", resolve);
  });
  if (code !== 0 || !fs.existsSync(out)) {
    const tail = Buffer.concat(log).toString("utf8").split("\n").slice(-40).join("\n");
    throw new Error(`released reader failed for ${releaseDir} (exit ${code}):\n${tail}`);
  }
  const observed = JSON.parse(fs.readFileSync(out, "utf8")) as ReleaseRun;
  if (values.dump) {
    fs.mkdirSync(values.dump, { recursive: true });
    fs.copyFileSync(out, path.join(values.dump, `${observed.version}-${label}.json`));
  }
  return observed;
}

const started = performance.now();
const runDir = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-catalog-compare-run-")),
);
try {
  const candidate = path.resolve(values.candidate);
  const baseline = values.baseline
    ? path.resolve(values.baseline)
    : path.join(runDir, "served.json");
  if (!values.baseline) {
    const response = await fetch(SERVED_CATALOG_URL);
    if (!response.ok) {
      throw new Error(`GET ${SERVED_CATALOG_URL}: HTTP ${response.status}`);
    }
    fs.writeFileSync(baseline, Buffer.from(await response.arrayBuffer()));
  }
  const releases = await releaseVersions();
  const cert = await selfSignedCert(runDir);
  const installs = await Promise.all(
    releases.map(async ({ version, label }) => ({
      version,
      label,
      dir: await installRelease(version),
    })),
  );
  const installedAt = performance.now();
  const compared = [baseline, candidate];
  const results = await Promise.all(
    installs.map(async ({ version, label, dir }) => {
      const [before, after] = await Promise.all([
        readRelease("baseline", dir, baseline, compared, runDir, cert),
        readRelease("candidate", dir, candidate, compared, runDir, cert),
      ]);
      const changes: Change[] = diffRuns(before, after);
      return {
        release: version,
        label,
        changes,
        rows: Math.max(before.rows.length, after.rows.length),
      };
    }),
  );
  const timing = {
    totalMs: Math.round(performance.now() - started),
    installMs: Math.round(installedAt - started),
    readMs: Math.round(performance.now() - installedAt),
  };
  if (values.json) {
    console.log(
      JSON.stringify(
        { baseline: values.baseline ?? SERVED_CATALOG_URL, candidate, timing, releases: results },
        null,
        2,
      ),
    );
  } else {
    console.log(formatReport(results));
    console.error(
      `[catalog-compare-released] rows ${results.map((r) => `${r.release}=${r.rows}`).join(" ")}; ` +
        `install ${timing.installMs} ms, read ${timing.readMs} ms, total ${timing.totalMs} ms`,
    );
  }
} finally {
  fs.rmSync(runDir, { recursive: true, force: true });
}
