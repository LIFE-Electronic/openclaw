import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  loadConfiguredPluginModelCatalog,
  configuredPluginProviderIds,
} from "./configured-plugin-catalog.js";

const mocks = vi.hoisted(() => ({
  snapshot: {
    plugins: [{ id: "remote-plugin", origin: "config", providers: ["remote"] }],
    index: {},
  },
  enabled: true,
  authenticated: true,
  syntheticAuth: undefined as { apiKey: string; mode: string; source: string } | undefined,
  ensure: vi.fn(),
  discover: vi.fn(),
}));
vi.mock("../plugins/manifest-contract-eligibility.js", () => ({
  loadManifestMetadataSnapshot: () => mocks.snapshot,
  isManifestPluginAvailableForControlPlane: () => mocks.enabled,
}));
vi.mock("./model-auth.js", () => ({ hasRuntimeAvailableProviderAuth: () => mocks.authenticated }));
vi.mock("../plugins/provider-runtime.js", () => ({
  resolveProviderSyntheticAuthWithPlugin: () => mocks.syntheticAuth,
}));
vi.mock("./models-config.js", () => ({ ensureOpenClawModelsJson: mocks.ensure }));
vi.mock("./agent-model-discovery.js", () => ({
  discoverAuthStorage: () => ({}),
  discoverModels: mocks.discover,
}));
const config: OpenClawConfig = {
  models: { providers: { remote: { baseUrl: "https://remote.test/v1", models: [] } } },
};
const row = {
  provider: "remote",
  id: "future-vision",
  name: "Future vision",
  input: ["text", "image"],
};

describe("configured plugin catalog", () => {
  beforeEach(() => {
    mocks.enabled = true;
    mocks.authenticated = true;
    mocks.syntheticAuth = undefined;
    mocks.ensure.mockReset().mockResolvedValue({ wrote: true });
    mocks.discover
      .mockReset()
      .mockReturnValue({ getAll: () => [row, { ...row, provider: "unrelated" }] });
  });
  it("discovers only enabled authenticated external providers and returns their actual metadata", async () => {
    expect(await loadConfiguredPluginModelCatalog({ config, agentDir: "/agent" })).toEqual([row]);
    expect(mocks.ensure).toHaveBeenCalledWith(
      config,
      "/agent",
      expect.objectContaining({ providerDiscoveryProviderIds: ["remote"] }),
    );
  });
  it.each(["disabled", "unauthenticated"])("does not discover a %s provider", async (state) => {
    mocks.enabled = state !== "disabled";
    mocks.authenticated = state !== "unauthenticated";
    expect(await loadConfiguredPluginModelCatalog({ config, agentDir: "/agent" })).toEqual([]);
    expect(mocks.ensure).not.toHaveBeenCalled();
  });
  it("lets cold discovery resolve a plugin-managed SecretRef before runtime auth is hydrated", async () => {
    mocks.authenticated = false;
    mocks.syntheticAuth = {
      apiKey: "secretref-managed",
      mode: "api-key",
      source: "plugin secret reference",
    };
    expect(await loadConfiguredPluginModelCatalog({ config, agentDir: "/agent" })).toEqual([row]);
    expect(mocks.ensure).toHaveBeenCalledWith(
      config,
      "/agent",
      expect.objectContaining({ providerDiscoveryProviderIds: ["remote"] }),
    );
  });
  it("retries a failed discovery without inventing model capabilities", async () => {
    mocks.ensure.mockRejectedValueOnce(new Error("discovery unavailable"));
    await expect(loadConfiguredPluginModelCatalog({ config, agentDir: "/agent" })).rejects.toThrow(
      "discovery unavailable",
    );
    expect(await loadConfiguredPluginModelCatalog({ config, agentDir: "/agent" })).toEqual([row]);
  });
  it("does not offer deferred tools for a disabled plugin", () => {
    mocks.enabled = false;
    expect(configuredPluginProviderIds({ config })).toEqual([]);
  });
});
