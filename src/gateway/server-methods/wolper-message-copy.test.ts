import { randomUUID } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import { CopyConflictError } from "../../infra/wolper-message-copy.js";
import type { GatewayRequestHandlerOptions } from "./types.js";
import { wolperBackgroundHandlers } from "./wolper-background.js";

const copyIntoSession = vi.hoisted(() => vi.fn());
vi.mock("../../infra/wolper-message-copy-runtime.js", () => ({ copyIntoSession }));
vi.mock("../../infra/wolper-background-runtime.js", () => ({
  materializeBackgroundResult: vi.fn(),
}));
const params = {
  copyId: randomUUID(),
  executionId: randomUUID(),
  destinationSessionKey: "agent:main:dashboard:linked",
  origin: { trigger: "heartbeat", is_heartbeat: true, cron_job_id: null },
  message: { role: "assistant", content: "Requested text" },
};
beforeEach(() => vi.clearAllMocks());

async function invoke(mode: string, input: unknown = params) {
  const respond = vi.fn();
  const broadcast = vi.fn();
  const options = {
    params: input,
    client: { connect: { client: { mode } } },
    respond,
    context: { broadcast, logGateway: { info: vi.fn(), error: vi.fn() } },
  } as unknown as GatewayRequestHandlerOptions;
  await wolperBackgroundHandlers["wolper.messages.copy"](options);
  return { respond, broadcast };
}

it("restricts copies to backend clients and validates input before mutation", async () => {
  expect((await invoke("ui")).respond.mock.calls[0][0]).toBe(false);
  expect(
    (await invoke("backend", { ...params, destinationSessionKey: "../../other" })).respond.mock
      .calls[0][0],
  ).toBe(false);
  expect(copyIntoSession).not.toHaveBeenCalled();
});

it("returns and emits the same committed native receipt", async () => {
  const receipt = {
    status: "committed",
    copyId: params.copyId,
    message: { content: "Stored text" },
  };
  copyIntoSession.mockResolvedValue(receipt);
  const { respond, broadcast } = await invoke("backend");
  expect(respond).toHaveBeenCalledWith(true, receipt);
  expect(broadcast).toHaveBeenCalledWith("wolper.message.copied", receipt);
  expect(copyIntoSession).toHaveBeenCalledWith(params);
});

it("does not emit an uncommitted busy result", async () => {
  copyIntoSession.mockResolvedValue({ status: "busy", copyId: params.copyId });
  const { broadcast } = await invoke("backend");
  expect(broadcast).not.toHaveBeenCalled();
});

it("reports permanent identity or session conflicts without suggesting a retry", async () => {
  copyIntoSession.mockRejectedValue(new CopyConflictError("private details"));
  const { respond, broadcast } = await invoke("backend");
  expect(respond).toHaveBeenCalledWith(
    false,
    undefined,
    expect.objectContaining({ code: "INVALID_REQUEST", message: "Native copy conflict" }),
  );
  expect(broadcast).not.toHaveBeenCalled();
});
