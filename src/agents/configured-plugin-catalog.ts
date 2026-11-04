import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  isManifestPluginAvailableForControlPlane,
  loadManifestMetadataSnapshot,
} from "../plugins/manifest-contract-eligibility.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { NON_ENV_SECRETREF_MARKER } from "./model-auth-markers.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import { normalizeProviderId } from "./provider-id.js";

type CatalogContext = {
  config: OpenClawConfig;
  workspaceDir?: string;
  metadataSnapshot?: Pick<PluginMetadataSnapshot, "index" | "plugins">;
};

/** External providers own their catalog; an empty authored models array is not an empty catalog. */
export function configuredPluginProviderIds(params: CatalogContext): string[] {
  if (params.config.plugins?.enabled === false || !params.config.models?.providers) {
    return [];
  }
  const snapshot = params.metadataSnapshot ?? loadManifestMetadataSnapshot(params);
  const configured = new Set(Object.keys(params.config.models.providers).map(normalizeProviderId));
  return [
    ...new Set(
      snapshot.plugins.flatMap((plugin) =>
        plugin.origin !== "bundled" &&
        isManifestPluginAvailableForControlPlane({
          snapshot,
          plugin,
          config: params.config,
        })
          ? plugin.providers.filter((provider) => configured.has(normalizeProviderId(provider)))
          : [],
      ),
    ),
  ];
}

/** Read native scoped catalog discovery before authored inference overrides are merged. */
export async function loadConfiguredPluginModelCatalog(
  params: CatalogContext & { agentDir: string },
): Promise<Array<ModelCatalogEntry & { baseUrl?: string }>> {
  const candidates = configuredPluginProviderIds(params);
  if (candidates.length === 0) {
    return [];
  }
  const { hasRuntimeAvailableProviderAuth } = await import("./model-auth.js");
  const { resolveProviderSyntheticAuthWithPlugin } = await import("../plugins/provider-runtime.js");
  const providers = candidates.filter((provider) => {
    if (
      hasRuntimeAvailableProviderAuth({
        provider,
        cfg: params.config,
        workspaceDir: params.workspaceDir,
      })
    ) {
      return true;
    }
    // Cold CLI config still contains SecretRefs. The plugin owns resolving them
    // during authenticated discovery; runtime auth correctly rejects the marker.
    return (
      resolveProviderSyntheticAuthWithPlugin({
        provider,
        config: params.config,
        workspaceDir: params.workspaceDir,
        context: {
          provider,
          config: params.config,
          providerConfig: params.config.models?.providers?.[provider],
        },
      })?.apiKey === NON_ENV_SECRETREF_MARKER
    );
  });
  if (providers.length === 0) {
    return [];
  }
  const { resolveImplicitProviders } = await import("./models-config.providers.js");
  const catalog = await resolveImplicitProviders({
    config: params.config,
    agentDir: params.agentDir,
    workspaceDir: params.workspaceDir,
    explicitProviders: params.config.models?.providers ?? {},
    providerDiscoveryProviderIds: providers,
    catalogOnly: true,
  });
  // Registry/inference resolution applies authored overrides, including stale
  // text-only rows. Browse and vision selection need the provider's catalog.
  // Project only catalog metadata: runtime auth/headers must never reach browse responses.
  return Object.entries(catalog ?? {})
    .filter(([provider]) => providers.includes(provider))
    .flatMap(([provider, definition]) =>
      definition.models.map((model) => ({
        provider,
        id: model.id,
        name: model.name,
        input: [...model.input],
        contextWindow: model.contextWindow,
        reasoning: model.reasoning,
        baseUrl: definition.baseUrl,
      })),
    );
}
