import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateModelsListParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
  resolveDefaultAgentDir,
} from "../../agents/agent-scope.js";
import { loadConfiguredPluginModelCatalog } from "../../agents/configured-plugin-catalog.js";
import { DEFAULT_PROVIDER } from "../../agents/defaults.js";
import {
  loadModelCatalogForBrowse,
  type ModelCatalogBrowseView,
} from "../../agents/model-catalog-browse.js";
import { resolveVisibleModelCatalog } from "../../agents/model-catalog-visibility.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import { createProviderAuthChecker } from "../../agents/model-provider-auth.js";
import { resolveDefaultAgentWorkspaceDir } from "../../agents/workspace.js";
import type { GatewayRequestHandlers } from "./types.js";

type ModelsListView = ModelCatalogBrowseView;

let loggedSlowModelsListCatalog = false;

function resolveModelsListView(params: Record<string, unknown>): ModelsListView {
  return typeof params.view === "string" ? (params.view as ModelsListView) : "default";
}

function omitRuntimeModelParams(entry: ModelCatalogEntry): ModelCatalogEntry {
  const { params: _params, ...rest } = entry as ModelCatalogEntry & {
    params?: Record<string, unknown>;
  };
  return rest;
}

function omitRuntimeModelParamsFromCatalog(catalog: ModelCatalogEntry[]): ModelCatalogEntry[] {
  return catalog.map(omitRuntimeModelParams);
}

export const modelsHandlers: GatewayRequestHandlers = {
  "models.list": async ({ params, respond, context }) => {
    if (!validateModelsListParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid models.list params: ${formatValidationErrors(validateModelsListParams.errors)}`,
        ),
      );
      return;
    }
    try {
      const cfg = context.getRuntimeConfig();
      const workspaceDir =
        resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg)) ??
        resolveDefaultAgentWorkspaceDir();
      const view = resolveModelsListView(params);
      const discovered = await loadModelCatalogForBrowse({
        cfg,
        view,
        loadCatalog: context.loadGatewayModelCatalog,
        onTimeout: (timeoutMs) => {
          if (loggedSlowModelsListCatalog) {
            return;
          }
          loggedSlowModelsListCatalog = true;
          context.logGateway.debug(
            `models.list continuing without model catalog after ${timeoutMs}ms`,
          );
        },
      });
      const pluginCatalog = await loadConfiguredPluginModelCatalog({
        config: cfg,
        agentDir: resolveDefaultAgentDir(cfg),
        workspaceDir,
      });
      const pluginProviders = new Set(pluginCatalog.map((model) => model.provider));
      const catalog = [
        ...discovered.filter((model) => !pluginProviders.has(model.provider)),
        ...pluginCatalog.map(({ baseUrl: _baseUrl, ...model }) => model),
      ];
      const hasAuth = createProviderAuthChecker({
        cfg,
        workspaceDir,
        allowPluginSyntheticAuth: false,
        discoverExternalCliAuth: false,
      });
      if (view === "all") {
        respond(true, { models: omitRuntimeModelParamsFromCatalog(catalog) }, undefined);
        return;
      }
      const models = await resolveVisibleModelCatalog({
        cfg,
        catalog,
        defaultProvider: DEFAULT_PROVIDER,
        workspaceDir,
        view,
        runtimeAuthDiscovery: false,
        providerAuthChecker: (provider) => pluginProviders.has(provider) || hasAuth(provider),
      });
      respond(true, { models: omitRuntimeModelParamsFromCatalog(models) }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },
};
