/** Appended to the contract; loading the extracted factory cannot start a Gateway. */
import { createRequire as backgroundRequire } from "node:module";
try {
  const store = await import(
    backgroundRequire("/app/package.json").resolve("@openclaw/fs-safe/store")
  );
  let count = 0;
  let result;
  for (const filename of await backgroundFs.readdir("/app/dist")) {
    if (!filename.endsWith(".js")) {
      continue;
    }
    const source = await backgroundFs.readFile("/app/dist/" + filename, "utf8");
    if (/(?:^|\n)function createWolperBackgroundContract(?:\$\d+)?\s*\(/.test(source)) {
      result = await verifyBackgroundContract(loadBackgroundContract(source, store));
      count += 1;
    }
  }
  backgroundAssert.ok(count > 0, "Installed pending-delivery protocol is missing");
  console.log(JSON.stringify(result));
} catch {
  console.log(JSON.stringify({ error: "Installed background-delivery verification failed" }));
  process.exitCode = 1;
}
