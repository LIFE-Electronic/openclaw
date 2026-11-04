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
  catalog: vi.fn(),
}));
vi.mock("../plugins/manifest-contract-eligibility.js", () => ({
  loadManifestMetadataSnapshot: () => mocks.snapshot,
  isManifestPluginAvailableForControlPlane: () => mocks.enabled,
}));
vi.mock("./model-auth.js", () => ({ hasRuntimeAvailableProviderAuth: () => mocks.authenticated }));
vi.mock("../plugins/provider-runtime.js", () => ({
  resolveProviderSyntheticAuthWithPlugin: () => mocks.syntheticAuth,
}));
vi.mock("./models-config.providers.js", () => ({ resolveImplicitProviders: mocks.catalog }));
const config: OpenClawConfig = {
  models: { providers: { remote: { baseUrl: "https://remote.test/v1", models: [] } } },
};
const row = {
  provider: "remote",
  id: "future-vision",
  name: "Future vision",
  input: ["text", "image"],
};
const staleConfig: OpenClawConfig = {
  models: {
    providers: {
      remote: {
        baseUrl: "https://remote.test/v1",
        models: [
          {
            id: row.id,
            name: row.name,
            input: ["text"],
            reasoning: false,
            contextWindow: 200000,
            maxTokens: 8192,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      },
    },
  },
};

describe("configured plugin catalog", () => {
  beforeEach(() => {
    mocks.enabled = true;
    mocks.authenticated = true;
    mocks.syntheticAuth = undefined;
    mocks.catalog
      .mockReset()
      .mockResolvedValue({ remote: { models: [row] }, unrelated: { models: [row] } });
  });
  it("discovers only enabled authenticated external providers and returns their actual metadata", async () => {
    expect(await loadConfiguredPluginModelCatalog({ config, agentDir: "/agent" })).toEqual([row]);
    expect(mocks.catalog).toHaveBeenCalledWith(
      expect.objectContaining({
        config,
        agentDir: "/agent",
        providerDiscoveryProviderIds: ["remote"],
        catalogOnly: true,
      }),
    );
  });
  it.each(["disabled", "unauthenticated"])("does not discover a %s provider", async (state) => {
    mocks.enabled = state !== "disabled";
    mocks.authenticated = state !== "unauthenticated";
    expect(await loadConfiguredPluginModelCatalog({ config, agentDir: "/agent" })).toEqual([]);
    expect(mocks.catalog).not.toHaveBeenCalled();
  });
  it("lets cold discovery resolve a plugin-managed SecretRef before runtime auth is hydrated", async () => {
    mocks.authenticated = false;
    mocks.syntheticAuth = {
      apiKey: "secretref-managed",
      mode: "api-key",
      source: "plugin secret reference",
    };
    expect(await loadConfiguredPluginModelCatalog({ config, agentDir: "/agent" })).toEqual([row]);
    expect(mocks.catalog).toHaveBeenCalledWith(
      expect.objectContaining({
        config,
        agentDir: "/agent",
        providerDiscoveryProviderIds: ["remote"],
      }),
    );
  });
  it("retries a failed discovery without inventing model capabilities", async () => {
    mocks.catalog.mockRejectedValueOnce(new Error("discovery unavailable"));
    await expect(loadConfiguredPluginModelCatalog({ config, agentDir: "/agent" })).rejects.toThrow(
      "discovery unavailable",
    );
    expect(await loadConfiguredPluginModelCatalog({ config, agentDir: "/agent" })).toEqual([row]);
  });
  it("uses catalog metadata over stale authored text-only rows", async () => {
    const authoritative = { ...row, contextWindow: 1048576 };
    mocks.catalog.mockResolvedValue({ remote: { models: [authoritative] } });
    expect(
      await loadConfiguredPluginModelCatalog({ config: staleConfig, agentDir: "/agent" }),
    ).toEqual([authoritative]);
  });
  it("does not offer deferred tools for a disabled plugin", () => {
    mocks.enabled = false;
    expect(configuredPluginProviderIds({ config })).toEqual([]);
  });
  it("does not invent catalog models from stale authored definitions", async () => {
    mocks.catalog.mockResolvedValue({ remote: { models: [] } });
    expect(
      await loadConfiguredPluginModelCatalog({ config: staleConfig, agentDir: "/agent" }),
    ).toEqual([]);
  });
});
