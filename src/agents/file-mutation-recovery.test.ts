import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AnyAgentTool } from "./agent-tools.types.js";
import { FileMutationRecovery } from "./file-mutation-recovery.js";

const completed = { content: [], details: { status: "completed", exitCode: 0 } };

describe("file mutation recovery", () => {
  let root: string;
  let target: string;
  let recovery: FileMutationRecovery;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "tool-recovery-"));
    target = path.join(root, "State.json");
    await fs.writeFile(target, '{"ids":["first","second"]}');
    recovery = new FileMutationRecovery();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  function tool(name: string, execute: AnyAgentTool["execute"], localExec = true) {
    return recovery.wrap(
      {
        name,
        label: name,
        description: name,
        parameters: { type: "object", properties: {} },
        execute,
      } as AnyAgentTool,
      { workspaceDir: root, cwd: root, localExec },
    );
  }

  async function fail(filePath = target, callId = "edit-1") {
    const edit = tool("edit", async () => {
      throw new Error("Could not find exact text");
    });
    await expect(edit.execute(callId, { path: filePath })).rejects.toThrow("exact text");
  }

  it("recognizes a successful fallback after two failed edits, preserving extra file data", async () => {
    await fail();
    await fail(target, "edit-2");
    const exec = tool("exec", async () => {
      await fs.writeFile(target, '{"ids":["first","second","third"]}');
      return completed;
    });
    await exec.execute("exec-1", { command: "python recovery.py" });
    expect(recovery.consumeRecovery("exec-1")).toBe("edit-2");
    expect(recovery.consumeRecovery("exec-1")).toBeUndefined();
  });

  it.each(["unchanged", "different file", "mtime only"])(
    "does not clear an error after %s",
    async (scenario) => {
      await fail();
      const exec = tool("exec", async () => {
        if (scenario === "different file") {
          await fs.writeFile(path.join(root, "other.json"), "changed");
        }
        if (scenario === "mtime only") {
          await fs.utimes(target, new Date(), new Date());
        }
        return completed;
      });
      await exec.execute("exec", {});
      expect(recovery.consumeRecovery("exec")).toBeUndefined();
    },
  );

  it.each([
    { status: "completed", exitCode: 1 },
    { status: "failed", exitCode: 0 },
    { status: "running", exitCode: 0 },
    { status: "approval-pending", exitCode: 0 },
    { status: "completed", exitCode: 0, timedOut: true },
  ])("requires terminal success: %j", async (details) => {
    await fail();
    await tool("exec", async () => {
      await fs.writeFile(target, "changed");
      return { content: [], details };
    }).execute("exec", {});
    expect(recovery.consumeRecovery("exec")).toBeUndefined();
  });

  it("does not attribute remote command success to local changes", async () => {
    await fail();
    await tool(
      "exec",
      async () => {
        await fs.writeFile(target, "changed");
        return completed;
      },
      false,
    ).execute("exec", {});
    expect(recovery.consumeRecovery("exec")).toBeUndefined();
  });

  it("preserves case and resolves relative path aliases", async () => {
    const edit = tool("edit", async () => {
      throw new Error("mismatch");
    });
    await expect(edit.execute("edit", { file_path: "State.json" })).rejects.toThrow();
    await tool("exec", async () => {
      await fs.writeFile(path.join(root, "state.json"), "unrelated");
      return completed;
    }).execute("wrong-case", {});
    expect(recovery.consumeRecovery("wrong-case")).toBeUndefined();
    await tool("exec", async () => {
      await fs.writeFile(target, "changed");
      return completed;
    }).execute("same-case", {});
    expect(recovery.consumeRecovery("same-case")).toBe("edit");
  });

  it.each(["outside", "symlink", "large", "missing"])(
    "keeps unverifiable %s targets unresolved",
    async (scenario) => {
      let file = target;
      if (scenario === "outside") {
        file = path.join(root, "..", "outside-recovery-proof");
      }
      if (scenario === "symlink") {
        file = path.join(root, "link");
        await fs.symlink(target, file);
      }
      if (scenario === "large") {
        await fs.writeFile(file, Buffer.alloc(1024 * 1024 + 1));
      }
      if (scenario === "missing") {
        await fs.unlink(file);
      }
      await fail(file);
      await tool("exec", async () => {
        await fs.writeFile(target, "changed");
        return completed;
      }).execute("exec", {});
      expect(recovery.consumeRecovery("exec")).toBeUndefined();
    },
  );

  it("rejects recovery when another mutation overlaps the command", async () => {
    await fail();
    await tool("exec", async () => {
      await tool("write", async () => {
        await fs.writeFile(target, "concurrent write");
        return completed;
      }).execute("writer", { path: target });
      return completed;
    }).execute("exec", {});
    expect(recovery.consumeRecovery("exec")).toBeUndefined();
  });

  it("does not share evidence between runs or newer errors", async () => {
    await fail();
    await tool("exec", async () => {
      await fs.writeFile(target, "changed");
      return completed;
    }).execute("exec", {});
    expect(new FileMutationRecovery().consumeRecovery("exec")).toBeUndefined();
    expect(recovery.consumeRecovery("exec")).toBe("edit-1");
  });

  it("retires a pending snapshot target after a successful same-file write", async () => {
    await fail();
    await tool("write", async () => {
      await fs.writeFile(target, "fixed");
      return completed;
    }).execute("write", { path: target });
    await tool("exec", async () => {
      await fs.writeFile(target, "later change");
      return completed;
    }).execute("exec", {});
    expect(recovery.consumeRecovery("exec")).toBeUndefined();
  });

  it("does not use changes made before command start or by a still-running process", async () => {
    await fail();
    await fs.writeFile(target, "already changed");
    await tool("exec", async () => completed).execute("no-write", {});
    expect(recovery.consumeRecovery("no-write")).toBeUndefined();
    await tool("exec", async () => ({
      content: [],
      details: { status: "running", sessionId: "background" },
    })).execute("background", {});
    await tool("exec", async () => {
      await fs.writeFile(target, "possibly from background process");
      return completed;
    }).execute("later", {});
    expect(recovery.consumeRecovery("later")).toBeUndefined();
  });

  it("does not trust a remote host override or forged tool evidence", async () => {
    await fail();
    await tool("exec", async () => {
      await fs.writeFile(target, "changed independently");
      return { ...completed, details: { ...completed.details, recoveredCallId: "edit-1" } };
    }).execute("exec", { host: "node" });
    expect(recovery.consumeRecovery("exec")).toBeUndefined();
  });
});
