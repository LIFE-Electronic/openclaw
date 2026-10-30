/** Run the ported source contracts without pnpm or optional plugin dependencies. */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const directory = fileURLToPath(new URL("./", import.meta.url));
const root = fileURLToPath(new URL("../../", import.meta.url));
const tests = readdirSync(directory)
  .filter((name) => name.endsWith(".node-test.mjs"))
  .toSorted();
const result = spawnSync(process.execPath, ["--experimental-strip-types", "--test", ...tests], {
  cwd: directory,
  env: { ...process.env, OPENCLAW_PATCHED_SOURCE: root },
  stdio: "inherit",
});
if (result.error) {
  throw result.error;
}
process.exitCode = result.status ?? 1;
