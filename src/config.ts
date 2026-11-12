import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import type { ModelProfile, Protocol } from "./types.ts";
import type { ProviderConfig } from "./providers/client.ts";

interface FileProvider extends Omit<ProviderConfig, "id" | "apiKey"> { apiKey?: string; apiKeyEnv?: string; apiKeyFile?: string; discoverModels?: boolean }
interface GatewayConfigFile { providers: Record<string, FileProvider>; models: Record<string, Omit<ModelProfile, "id">>; defaultModel: string; port?: number; host?: string }
export interface GatewayConfig { providers: ProviderConfig[]; models: ModelProfile[]; refreshModels(): Promise<ModelProfile[]>; defaultModel: string; port: number; host: string }

type CatalogMetadata = { attachment?: unknown; reasoning?: unknown; tool_call?: unknown; limit?: { context?: unknown; output?: unknown } };
type CatalogResponse = { anthropic?: unknown; openai?: unknown; glory?: unknown; metadata?: Record<string, Record<string, CatalogMetadata>> };

const snapshotBase = (id: string): string => id.replace(/-\d{8,14}$/, "");

function deduplicateCatalog(ids: string[]): string[] {
  const preferred = new Map<string, string>();
  for (const id of new Set(ids)) {
    const base = snapshotBase(id); const current = preferred.get(base);
    if (!current || id === base || (current !== base && id.localeCompare(current, undefined, { numeric: true }) > 0)) preferred.set(base, id);
  }
  return [...preferred.values()];
}

async function discoverModels(provider: ProviderConfig): Promise<ModelProfile[] | undefined> {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const url = `${provider.baseUrl.replace(/\/$/, "")}/models`;
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const catalog = await response.json() as CatalogResponse;
    const ids = deduplicateCatalog([catalog.anthropic, catalog.openai, catalog.glory].flatMap((value) => Array.isArray(value) ? value.filter((id): id is string => typeof id === "string" && id.length > 0) : []));
    const protocol = (["anthropic", "openai"] as Protocol[]).find((candidate) => provider.protocols?.[candidate]) ?? "anthropic";
    return ids.map((id) => {
      const metadata = catalog.metadata?.anthropic?.[id] ?? catalog.metadata?.openai?.[id] ?? catalog.metadata?.glory?.[id];
      const contextLimit = typeof metadata?.limit?.context === "number" ? metadata.limit.context : undefined;
      const maxOutputTokens = typeof metadata?.limit?.output === "number" ? metadata.limit.output : undefined;
      return { id, provider: provider.id, providerProtocol: protocol, upstreamModel: id, contextLimit, maxOutputTokens,
        capabilities: { tools: metadata?.tool_call !== false, vision: metadata?.attachment !== false, reasoning: metadata?.reasoning !== false, streaming: true } };
    });
  } catch (error) {
    console.warn(`[model-catalog] Could not refresh ${provider.id}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  } finally { clearTimeout(timer); }
}

export async function loadConfig(path = process.env.GATEWAY_CONFIG ?? "gateway.config.json"): Promise<GatewayConfig> {
  const file = JSON.parse(await readFile(path, "utf8")) as GatewayConfigFile;
  if (!file.defaultModel || !file.models?.[file.defaultModel]) throw new Error("defaultModel must name a configured model");
  const providerEntries = await Promise.all(Object.entries(file.providers ?? {}).map(async ([id, provider]) => {
    const keyPath = provider.apiKeyFile?.replace(/^~(?=\/)/, homedir());
    const fileKey = keyPath ? (await readFile(keyPath, "utf8")).trim() : undefined;
    const { apiKeyEnv: _apiKeyEnv, apiKeyFile: _apiKeyFile, discoverModels, ...config } = provider;
    return { discoverModels, provider: { ...config, id, apiKey: provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : fileKey ?? provider.apiKey } };
  }));
  const providers = providerEntries.map((entry) => entry.provider);
  const providerIds = new Set(providers.map((provider) => provider.id));
  const staticModels = Object.entries(file.models).map(([id, model]) => ({ ...model, id }));
  const discoverable = providerEntries.filter((entry) => entry.discoverModels).map((entry) => entry.provider);
  const discoveredByProvider = new Map<string, ModelProfile[]>();
  let loadedConfig: GatewayConfig | undefined;
  const refreshModels = async (): Promise<ModelProfile[]> => {
    const refreshed = await Promise.all(discoverable.map(async (provider) => ({ provider, models: await discoverModels(provider) })));
    for (const { provider, models } of refreshed) if (models !== undefined) discoveredByProvider.set(provider.id, models);
    const models = [...new Map([...discoveredByProvider.values()].flat().concat(staticModels).map((model) => [model.id, model])).values()];
    if (loadedConfig) loadedConfig.models = models;
    return models;
  };
  const models = await refreshModels();
  for (const model of models) {
    if (!providerIds.has(model.provider)) throw new Error(`Model ${model.id} references missing provider ${model.provider}`);
    const provider = providers.find((candidate) => candidate.id === model.provider)!;
    if (provider.protocols && !provider.protocols[model.providerProtocol]) throw new Error(`Provider ${provider.id} does not configure protocol ${model.providerProtocol} required by model ${model.id}`);
  }
  loadedConfig = { providers, models, refreshModels, defaultModel: file.defaultModel, port: file.port ?? Number(process.env.PORT ?? 8787), host: file.host ?? process.env.HOST ?? "127.0.0.1" };
  return loadedConfig;
}
