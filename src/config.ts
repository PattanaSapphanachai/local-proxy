import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import type { ModelProfile, Protocol } from "./types.ts";
import type { ProviderConfig } from "./providers/client.ts";

interface CatalogOptions {
  /** Catalog path under baseUrl. Defaults to /models. */
  modelsPath?: string;
  /** Prepended to discovered model IDs so two providers can list the same upstream model. */
  modelIdPrefix?: string;
  /** providerOptions given to every discovered model. */
  modelOptions?: Record<string, unknown>;
  discoveryTimeoutMs?: number;
}
interface FileProvider extends Omit<ProviderConfig, "id" | "apiKey" | "baseUrl">, CatalogOptions { baseUrl?: string; apiKey?: string; apiKeyEnv?: string; apiKeyFile?: string; discoverModels?: boolean }
interface GatewayConfigFile { providers: Record<string, FileProvider>; models: Record<string, Omit<ModelProfile, "id">>; defaultModel: string; port?: number; host?: string }
// Runtime overrides for a provider, typically entered by the user in the control UI. An empty apiKey clears the key.
export interface ProviderOverride { apiKey?: string; baseUrl?: string }
// Starts a backend the gateway runs itself and returns its base URL. Called only when the config names that backend.
export interface EmbeddedBackends { chatgpt?: () => Promise<string> }
export interface GatewayConfig {
  providers: ProviderConfig[]; models: ModelProfile[]; refreshModels(): Promise<ModelProfile[]>;
  updateProvider(id: string, override: ProviderOverride): ProviderConfig; defaultModel: string; port: number; host: string;
}

// codex-as-api rejects these chat fields outright (even when the client sent them), so they are cleared on every request.
const CHATGPT_UNSUPPORTED = { max_completion_tokens: null, max_tokens: null, temperature: null, top_p: null, stop: null, stream_options: null };
const CHATGPT_DEFAULTS: FileProvider = {
  discoverModels: true, modelsPath: "/v1/models", modelIdPrefix: "codex-", discoveryTimeoutMs: 15_000,
  modelOptions: { openai: CHATGPT_UNSUPPORTED }, protocols: { openai: { path: "/v1/chat/completions", auth: "none" } }
};

type CatalogMetadata = { attachment?: unknown; reasoning?: unknown; tool_call?: unknown; limit?: { context?: unknown; output?: unknown } };
type CatalogResponse = { anthropic?: unknown; openai?: unknown; glory?: unknown; metadata?: Record<string, Record<string, CatalogMetadata>>; data?: unknown };
type OpenAICatalogEntry = { id?: unknown; visibility?: unknown; supported_in_api?: unknown; context_window?: unknown; input_modalities?: unknown; supported_reasoning_levels?: unknown };

const snapshotBase = (id: string): string => id.replace(/-\d{8,14}$/, "");

function deduplicateCatalog(ids: string[]): string[] {
  const preferred = new Map<string, string>();
  for (const id of new Set(ids)) {
    const base = snapshotBase(id); const current = preferred.get(base);
    if (!current || id === base || (current !== base && id.localeCompare(current, undefined, { numeric: true }) > 0)) preferred.set(base, id);
  }
  return [...preferred.values()];
}

type Warn = (line: string) => void;
type Discoverable = { provider: ProviderConfig; catalog: CatalogOptions };

async function discoverModels({ provider, catalog: options }: Discoverable): Promise<ModelProfile[]> {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), options.discoveryTimeoutMs ?? 5_000);
  try {
    const url = `${provider.baseUrl.replace(/\/$/, "")}${options.modelsPath ?? "/models"}`;
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}${response.status === 401 && provider.embedded === "chatgpt" ? " (not signed in to ChatGPT)" : ""}`);
    const catalog = await response.json() as CatalogResponse;
    const protocol = (["anthropic", "openai"] as Protocol[]).find((candidate) => provider.protocols?.[candidate]) ?? "anthropic";
    const profile = (upstreamModel: string, rest: Omit<ModelProfile, "id" | "provider" | "providerProtocol" | "upstreamModel">): ModelProfile => ({
      id: `${options.modelIdPrefix ?? ""}${upstreamModel}`, provider: provider.id, providerProtocol: protocol, upstreamModel, ...rest,
      ...(options.modelOptions ? { providerOptions: structuredClone(options.modelOptions) } : {}) });
    // OpenAI-style list, as served by codex-as-api: { object: "list", data: [{ id, context_window, ... }] }
    if (Array.isArray(catalog.data)) {
      return (catalog.data as OpenAICatalogEntry[]).filter((entry): entry is OpenAICatalogEntry & { id: string } => typeof entry?.id === "string" && entry.id.length > 0
        && entry.supported_in_api !== false && (entry.visibility === undefined || entry.visibility === "list"))
        .map((entry) => profile(entry.id, { contextLimit: typeof entry.context_window === "number" ? entry.context_window : undefined,
          capabilities: { tools: true, vision: Array.isArray(entry.input_modalities) ? entry.input_modalities.includes("image") : true,
            reasoning: Array.isArray(entry.supported_reasoning_levels) ? entry.supported_reasoning_levels.length > 0 : true, streaming: true } }));
    }
    const ids = deduplicateCatalog([catalog.anthropic, catalog.openai, catalog.glory].flatMap((value) => Array.isArray(value) ? value.filter((id): id is string => typeof id === "string" && id.length > 0) : []));
    return ids.map((id) => {
      const metadata = catalog.metadata?.anthropic?.[id] ?? catalog.metadata?.openai?.[id] ?? catalog.metadata?.glory?.[id];
      const contextLimit = typeof metadata?.limit?.context === "number" ? metadata.limit.context : undefined;
      const maxOutputTokens = typeof metadata?.limit?.output === "number" ? metadata.limit.output : undefined;
      return profile(id, { contextLimit, maxOutputTokens,
        capabilities: { tools: metadata?.tool_call !== false, vision: metadata?.attachment !== false, reasoning: metadata?.reasoning !== false, streaming: true } });
    });
  } finally { clearTimeout(timer); }
}

export async function loadConfig(path = process.env.GATEWAY_CONFIG ?? "gateway.config.json", overrides: Record<string, ProviderOverride> = {}, warn: Warn = (line) => console.warn(line), embedded: EmbeddedBackends = {}): Promise<GatewayConfig> {
  const file = JSON.parse(await readFile(path, "utf8")) as GatewayConfigFile;
  if (!file.defaultModel || !file.models?.[file.defaultModel]) throw new Error("defaultModel must name a configured model");
  const providerEntries = await Promise.all(Object.entries(file.providers ?? {}).map(async ([id, fileProvider]) => {
    if (fileProvider.embedded !== undefined && fileProvider.embedded !== "chatgpt") throw new Error(`Provider ${id} names an unknown embedded backend: ${fileProvider.embedded}`);
    const isEmbedded = fileProvider.embedded === "chatgpt";
    const provider: FileProvider = isEmbedded ? { ...CHATGPT_DEFAULTS, ...fileProvider } : fileProvider;
    // An embedded backend has no key and its address is chosen at startup, so saved overrides do not apply.
    const override = isEmbedded ? {} : overrides[id] ?? {};
    const keyPath = override.apiKey === undefined ? provider.apiKeyFile?.replace(/^~(?=\/)/, homedir()) : undefined;
    const fileKey = keyPath ? await readFile(keyPath, "utf8").then((key) => key.trim(), (error: { code?: string }) => {
      if (error.code !== "ENOENT") throw error;
      warn(`[config] API key file for ${id} not found: ${keyPath}`); return undefined;
    }) : undefined;
    const { apiKeyEnv: _apiKeyEnv, apiKeyFile: _apiKeyFile, discoverModels, modelsPath, modelIdPrefix, modelOptions, discoveryTimeoutMs, ...config } = provider;
    let baseUrl = override.baseUrl ?? config.baseUrl;
    if (isEmbedded) {
      if (!embedded.chatgpt) throw new Error(`Provider ${id} needs the embedded ChatGPT backend, which this gateway was started without`);
      baseUrl = await embedded.chatgpt();
    }
    if (!baseUrl) throw new Error(`Provider ${id} needs a baseUrl`);
    const apiKey = override.apiKey !== undefined ? override.apiKey || undefined : provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : fileKey ?? provider.apiKey;
    return { discoverModels, catalog: { modelsPath, modelIdPrefix, modelOptions, discoveryTimeoutMs }, provider: { ...config, id, baseUrl, apiKey } as ProviderConfig };
  }));
  const providers = providerEntries.map((entry) => entry.provider);
  const providerIds = new Set(providers.map((provider) => provider.id));
  const staticModels = Object.entries(file.models).map(([id, model]) => ({ ...model, id }));
  const discoverable: Discoverable[] = providerEntries.filter((entry) => entry.discoverModels);
  const discoveredByProvider = new Map<string, ModelProfile[]>();
  // Repeated identical failures (an offline catalog, a missing ChatGPT sign-in) are reported once until they change.
  const lastFailure = new Map<string, string>();
  let loadedConfig: GatewayConfig | undefined;
  const refreshModels = async (): Promise<ModelProfile[]> => {
    await Promise.all(discoverable.map(async (entry) => {
      try { discoveredByProvider.set(entry.provider.id, await discoverModels(entry)); lastFailure.delete(entry.provider.id); }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (lastFailure.get(entry.provider.id) !== message) warn(`[model-catalog] Could not refresh ${entry.provider.id}: ${message}`);
        lastFailure.set(entry.provider.id, message);
      }
    }));
    const models = [...new Map([...discoveredByProvider.values()].flat().concat(staticModels).map((model) => [model.id, model])).values()];
    if (loadedConfig) loadedConfig.models = models;
    return models;
  };
  // Mutates the shared ProviderConfig so model discovery and any client holding the same object see the change.
  const updateProvider = (id: string, override: ProviderOverride): ProviderConfig => {
    const provider = providers.find((candidate) => candidate.id === id);
    if (!provider) throw new Error(`Unknown provider: ${id}`);
    if (provider.embedded) throw new Error(`Provider ${id} is run by the gateway and has no editable settings`);
    if (override.baseUrl !== undefined) provider.baseUrl = override.baseUrl;
    if (override.apiKey !== undefined) provider.apiKey = override.apiKey || undefined;
    return provider;
  };
  const models = await refreshModels();
  for (const model of models) {
    if (!providerIds.has(model.provider)) throw new Error(`Model ${model.id} references missing provider ${model.provider}`);
    const provider = providers.find((candidate) => candidate.id === model.provider)!;
    if (provider.protocols && !provider.protocols[model.providerProtocol]) throw new Error(`Provider ${provider.id} does not configure protocol ${model.providerProtocol} required by model ${model.id}`);
  }
  loadedConfig = { providers, models, refreshModels, updateProvider, defaultModel: file.defaultModel, port: file.port ?? Number(process.env.PORT ?? 8787), host: file.host ?? process.env.HOST ?? "127.0.0.1" };
  return loadedConfig;
}
