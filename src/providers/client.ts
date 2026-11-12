import type { Protocol } from "../types.ts";
import { GatewayError } from "../errors.ts";

export type ProviderAuth = "bearer" | "anthropic" | "none";
export interface ProviderProtocolConfig { baseUrl?: string; path?: string; auth?: ProviderAuth; headers?: Record<string, string> }
export interface ProviderConfig {
  id: string;
  baseUrl: string;
  apiKey?: string;
  timeoutMs?: number;
  auth?: ProviderAuth;
  headers?: Record<string, string>;
  protocols?: Partial<Record<Protocol, ProviderProtocolConfig>>;
}
export interface ProviderRequest { providerId: string; protocol: Protocol; body: Record<string, unknown>; stream: boolean; headers?: Record<string, string> }
export interface ProviderClient {
  complete(request: ProviderRequest): Promise<Record<string, unknown>>;
  stream(request: ProviderRequest): AsyncIterable<Record<string, unknown>>;
}

// Upstreams such as Meridian choose their client adapter and session identity from these headers.
// Without them every tool round is a headerless request that replays a fresh session with no cache reuse.
const CLIENT_IDENTITY_HEADERS = ["user-agent", "x-claude-code-agent-id", "x-claude-code-parent-agent-id", "x-claude-code-request-class"] as const;
export function clientIdentityHeaders(incoming: Record<string, string | string[] | undefined>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of CLIENT_IDENTITY_HEADERS) { const value = incoming[name]; if (typeof value === "string" && value) result[name] = value; }
  return result;
}

export class HttpProviderClient implements ProviderClient {
  readonly #providers = new Map<string, ProviderConfig>();
  constructor(providers: ProviderConfig[]) { for (const provider of providers) this.#providers.set(provider.id, provider); }
  #config(id: string): ProviderConfig {
    const config = this.#providers.get(id);
    if (!config) throw new GatewayError("UPSTREAM_UNAVAILABLE", `Provider is not configured: ${id}`, 502);
    return config;
  }
  async #fetch(request: ProviderRequest): Promise<Response> {
    const config = this.#config(request.providerId);
    const protocolConfig = config.protocols?.[request.protocol];
    if (config.protocols && !protocolConfig) throw new GatewayError("UPSTREAM_UNAVAILABLE", `Provider ${config.id} does not configure the ${request.protocol} protocol`, 502);
    const endpoint = protocolConfig?.path ?? (request.protocol === "anthropic" ? "/v1/messages" : "/v1/chat/completions");
    const headers: Record<string, string> = { "content-type": "application/json", ...request.headers, ...config.headers, ...protocolConfig?.headers };
    const auth = protocolConfig?.auth ?? config.auth ?? (request.protocol === "anthropic" ? "anthropic" : "bearer");
    if (config.apiKey) {
      if (auth === "anthropic") { headers["x-api-key"] = config.apiKey; headers["anthropic-version"] ??= "2023-06-01"; }
      else if (auth === "bearer") headers.authorization = `Bearer ${config.apiKey}`;
    }
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? 120_000);
    try {
      const baseUrl = protocolConfig?.baseUrl ?? config.baseUrl;
      const response = await fetch(`${baseUrl.replace(/\/$/, "")}${endpoint.startsWith("/") ? endpoint : `/${endpoint}`}`, { method: "POST", headers, body: JSON.stringify(request.body), signal: controller.signal });
      if (!response.ok) {
        const detail = await response.text();
        const code = response.status === 401 || response.status === 403 ? "AUTHENTICATION_ERROR" : response.status === 429 ? "RATE_LIMIT" : response.status === 400 ? "INVALID_REQUEST" : "UPSTREAM_UNAVAILABLE";
        throw new GatewayError(code, `Upstream ${response.status}: ${detail.slice(0, 500)}`, response.status, response.status === 429 || response.status >= 500);
      }
      return response;
    } finally { clearTimeout(timer); }
  }
  async complete(request: ProviderRequest): Promise<Record<string, unknown>> { return await (await this.#fetch(request)).json() as Record<string, unknown>; }
  async *stream(request: ProviderRequest): AsyncIterable<Record<string, unknown>> {
    const response = await this.#fetch(request); if (!response.body) throw new GatewayError("UPSTREAM_UNAVAILABLE", "Upstream returned no stream body", 502);
    const decoder = new TextDecoder(); let buffer = "";
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
        if (!data || data === "[DONE]") continue;
        try { yield JSON.parse(data); } catch { throw new GatewayError("PROTOCOL_TRANSLATION_ERROR", "Invalid JSON in upstream SSE event", 502); }
      }
    }
  }
}
