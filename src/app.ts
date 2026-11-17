import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { readFile } from "node:fs/promises";
import { extname, normalize, resolve, sep } from "node:path";
import { loadConfig, type GatewayConfig, type ProviderOverride } from "./config.ts";
import { ModelRegistry } from "./models/registry.ts";
import { InMemorySessionStore } from "./sessions/store.ts";
import { SessionService } from "./sessions/service.ts";
import { loadRoutingState, RoutingService, saveRoutingState } from "./routing/service.ts";
import { AdapterRegistry } from "./adapters/provider.ts";
import { AnthropicAdapter } from "./adapters/anthropic.ts";
import { OpenAIAdapter } from "./adapters/openai.ts";
import { clientIdentityHeaders, HttpProviderClient } from "./providers/client.ts";
import { JsonConsoleObserver, LogBuffer, type LogLine } from "./observability.ts";
import { Gateway } from "./gateway.ts";
import { clientError, GatewayError, normalizeError } from "./errors.ts";
import { apiKeyHint, loadUserSettings, saveUserSettings, type UserSettings } from "./user-settings.ts";
import { startChatGPTBackend, type ChatGPTBackend, type ChatGPTBackendOptions } from "./chatgpt.ts";
import { claudeDesktopStatus, defaultEnvironment, openClaudeDesktop, setDeploymentMode, setupClaudeDesktop, type ClaudeDesktopEnvironment } from "./claude-desktop.ts";
import type { Protocol, RoutingMode } from "./types.ts";

export interface GatewayAppOptions {
  /** Base gateway config. Defaults to GATEWAY_CONFIG or ./gateway.config.json. */
  configPath?: string;
  /** Where the selected route is persisted. Defaults to GATEWAY_STATE or ./.gateway-state.json. */
  statePath?: string;
  /** Where UI-entered API keys and base URLs are persisted. Defaults to GATEWAY_USER_SETTINGS; unset means in-memory only. */
  userSettingsPath?: string;
  /** Directory whose files are served at GET / (index.html) for the control UI. Unset disables static serving. */
  uiDir?: string;
  host?: string;
  port?: number;
  /** How many recent log lines GET /logs keeps in memory. Defaults to 500. */
  logCapacity?: number;
  /** Claude Desktop integration environment (data folder, credential helper, app paths). Defaults to the current user's macOS locations. */
  claudeDesktop?: Partial<ClaudeDesktopEnvironment>;
  /** Embedded ChatGPT backend, started only when the config has a provider with "embedded": "chatgpt". */
  chatgpt?: ChatGPTBackendOptions;
  warn?: (line: string) => void;
}

export interface RunningGateway {
  host: string; port: number; url: string; config: GatewayConfig; server: Server; logs: LogBuffer;
  close(): Promise<void>;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon"
};
const describe = (error: unknown): string => error instanceof Error ? error.message : String(error);

async function jsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > 20 * 1024 * 1024) throw new Error("Request body exceeds 20MB"); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
const sendJson = (response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  response.writeHead(status, { "content-type": "application/json", ...headers }); response.end(JSON.stringify(body));
};
// Log replay cursor: EventSource reconnects send Last-Event-ID; the UI's first connect passes ?since=.
const sinceId = (request: IncomingMessage, url: URL): number => {
  const raw = request.headers["last-event-id"] ?? url.searchParams.get("since") ?? "0";
  const id = Number(raw); return Number.isFinite(id) && id > 0 ? Math.floor(id) : 0;
};

export async function startGateway(options: GatewayAppOptions = {}): Promise<RunningGateway> {
  const logs = new LogBuffer(options.logCapacity);
  const emitWarning = options.warn ?? ((line: string) => console.warn(line));
  const warn = (line: string) => { logs.push("warn", line); emitWarning(line); };
  const configPath = options.configPath ?? process.env.GATEWAY_CONFIG ?? "gateway.config.json";
  const statePath = options.statePath ?? process.env.GATEWAY_STATE ?? ".gateway-state.json";
  const userSettingsPath = options.userSettingsPath ?? process.env.GATEWAY_USER_SETTINGS;
  const uiRoot = options.uiDir ? resolve(options.uiDir) : undefined;
  const claudeDesktop = defaultEnvironment(options.claudeDesktop);

  let userSettings: UserSettings = { providers: {} };
  if (userSettingsPath) {
    try { userSettings = await loadUserSettings(userSettingsPath); }
    catch (error) { warn(`[user-settings] Could not read ${userSettingsPath}: ${describe(error)}`); }
  }
  let chatgpt: ChatGPTBackend | undefined;
  const startChatGPT = async () => (chatgpt ??= await startChatGPTBackend(options.chatgpt)).url;
  let config: GatewayConfig;
  try { config = await loadConfig(configPath, userSettings.providers, warn, { chatgpt: startChatGPT }); }
  catch (error) { await chatgpt?.close().catch(() => {}); throw error; }
  const host = options.host ?? config.host; const port = options.port ?? config.port;
  let boundPort = port; // replaced with the real port after listen (port 0 picks a free one)
  const models = new ModelRegistry(config.models); const sessions = new SessionService(new InMemorySessionStore());
  const routing = new RoutingService(models, config.defaultModel);
  try {
    const savedRoute = await loadRoutingState(statePath);
    if (savedRoute) routing.update(savedRoute);
  } catch (error) { warn(`[routing-state] Could not restore: ${describe(error)}`); }
  const providers = new HttpProviderClient(config.providers);
  const gateway = new Gateway(models, sessions, routing, new AdapterRegistry([new AnthropicAdapter(), new OpenAIAdapter()]), providers, undefined, new JsonConsoleObserver(undefined, logs));
  const startedAt = new Date();

  async function refreshModels() {
    models.replace(await config.refreshModels());
    if (!models.has(routing.get().modelId)) await saveRoutingState(statePath, routing.update({ model: config.defaultModel }));
  }
  function routingStatus() {
    const route = routing.get(); const model = models.get(route.modelId);
    return { mode: route.mode, model: model.id, reasoningEffort: route.reasoningEffort ?? null, provider: model.provider, upstreamProtocol: model.providerProtocol, upstreamModel: model.upstreamModel, updatedAt: route.updatedAt };
  }
  function settingsStatus() {
    return { persisted: Boolean(userSettingsPath), defaultProvider: models.get(config.defaultModel).provider,
      providers: config.providers.filter((provider) => !provider.embedded).map((provider) => ({ id: provider.id, baseUrl: provider.baseUrl, hasApiKey: Boolean(provider.apiKey), apiKeyHint: apiKeyHint(provider.apiKey) })) };
  }
  async function updateSettings(body: Record<string, unknown>) {
    const providerId = typeof body.provider === "string" && body.provider ? body.provider : models.get(config.defaultModel).provider;
    const current = config.providers.find((provider) => provider.id === providerId);
    if (!current) throw new GatewayError("INVALID_REQUEST", `Unknown provider: ${providerId}`, 400);
    if (current.embedded) throw new GatewayError("INVALID_REQUEST", `Provider ${providerId} is run by the gateway and has no editable settings`, 400);
    const override: ProviderOverride = {};
    if (body.baseUrl !== undefined) {
      if (typeof body.baseUrl !== "string") throw new GatewayError("INVALID_REQUEST", "baseUrl must be a string", 400);
      let url: URL;
      try { url = new URL(body.baseUrl.trim()); } catch { throw new GatewayError("INVALID_REQUEST", "baseUrl must be a valid http(s) URL", 400); }
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new GatewayError("INVALID_REQUEST", "baseUrl must use http or https", 400);
      override.baseUrl = url.toString().replace(/\/$/, "");
    }
    if (body.apiKey !== undefined) {
      if (typeof body.apiKey !== "string") throw new GatewayError("INVALID_REQUEST", "apiKey must be a string", 400);
      override.apiKey = body.apiKey.trim();
    }
    if (override.baseUrl === undefined && override.apiKey === undefined) throw new GatewayError("INVALID_REQUEST", "Settings update requires apiKey or baseUrl", 400);
    const previous: ProviderOverride = { baseUrl: current.baseUrl, apiKey: current.apiKey ?? "" };
    providers.configure(config.updateProvider(providerId, override));
    const stored = { ...userSettings.providers[providerId] };
    if (override.baseUrl !== undefined) stored.baseUrl = override.baseUrl;
    if (override.apiKey !== undefined) { if (override.apiKey) stored.apiKey = override.apiKey; else delete stored.apiKey; }
    const next: UserSettings = { providers: { ...userSettings.providers, [providerId]: stored } };
    if (userSettingsPath) {
      try { await saveUserSettings(userSettingsPath, next); }
      catch (error) { providers.configure(config.updateProvider(providerId, previous)); throw error; }
    }
    userSettings = next;
    logs.push("info", `[settings] ${providerId} → ${current.baseUrl} ${current.apiKey ? `(key ${apiKeyHint(current.apiKey)})` : "(no key)"}`);
    try { await refreshModels(); } catch (error) { warn(`[model-catalog] Refresh after settings change failed: ${describe(error)}`); }
    return settingsStatus();
  }
  async function serveStatic(pathname: string, response: ServerResponse): Promise<boolean> {
    if (!uiRoot) return false;
    const relative = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
    const file = resolve(uiRoot, normalize(relative));
    if (file !== uiRoot && !file.startsWith(uiRoot + sep)) return false;
    try {
      const data = await readFile(file);
      response.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" }); response.end(data);
      return true;
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "ENOENT" || code === "EISDIR" || code === "ENOTDIR") return false;
      throw error;
    }
  }

  // ChatGPT sign-in for the embedded backend. Tokens are written to the same auth.json the Codex app and CLI use.
  const chatgptProvider = () => config.providers.find((provider) => provider.embedded === "chatgpt");
  const requireChatGPT = (): ChatGPTBackend => {
    if (!chatgpt) throw new GatewayError("INVALID_REQUEST", "No ChatGPT provider is configured", 404);
    return chatgpt;
  };
  async function chatgptStatus() {
    const provider = chatgptProvider();
    if (!chatgpt || !provider) return { enabled: false };
    return { enabled: true, provider: provider.id, status: await chatgpt.status(), modelCount: models.list().filter((model) => model.provider === provider.id).length };
  }
  async function chatgptLogin(id: string) {
    const login = await requireChatGPT().login(id);
    if (login.status === "succeeded") {
      logs.push("info", `[chatgpt] signed in`);
      try { await refreshModels(); } catch (error) { warn(`[model-catalog] Refresh after ChatGPT sign-in failed: ${describe(error)}`); }
    }
    return login;
  }

  // Claude Desktop's profile names a loopback gateway as localhost, matching the manual setup known to work.
  const desktopGatewayUrl = () => `http://${["127.0.0.1", "0.0.0.0", "::1", "::"].includes(host) ? "localhost" : host}:${boundPort}`;

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    let protocol: Protocol = url.pathname === "/v1/messages" ? "anthropic" : "openai";
    try {
      if (request.method === "GET" && url.pathname === "/health") return sendJson(response, 200, { ok: true });
      if (request.method === "GET" && url.pathname === "/status") return sendJson(response, 200, { ok: true, startedAt, uptimeSeconds: Math.floor(process.uptime()), url: `http://${host}:${boundPort}`, routing: routingStatus(), modelCount: models.list().length });
      if (request.method === "GET" && url.pathname === "/routing") return sendJson(response, 200, routingStatus());
      if (request.method === "PUT" && url.pathname === "/routing") {
        const body = await jsonBody(request);
        const previous = routing.get();
        const updated = routing.update({ model: typeof body.model === "string" ? body.model : undefined, mode: body.mode as RoutingMode | undefined, reasoningEffort: body.reasoningEffort as any });
        try { await saveRoutingState(statePath, updated); }
        catch (error) { routing.update({ model: previous.modelId, mode: previous.mode, reasoningEffort: previous.reasoningEffort ?? null }); throw error; }
        logs.push("info", `[routing] now ${updated.modelId} · ${updated.mode}${updated.reasoningEffort ? ` · effort ${updated.reasoningEffort}` : ""}`);
        return sendJson(response, 200, routingStatus());
      }
      if (request.method === "GET" && url.pathname === "/settings") return sendJson(response, 200, settingsStatus());
      if (request.method === "PUT" && url.pathname === "/settings") return sendJson(response, 200, await updateSettings(await jsonBody(request)));
      if (request.method === "GET" && url.pathname === "/logs") return sendJson(response, 200, { lines: logs.since(sinceId(request, url)) });
      if (request.method === "GET" && url.pathname === "/logs/stream") {
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        const send = (line: LogLine) => { response.write(`id: ${line.id}\ndata: ${JSON.stringify(line)}\n\n`); };
        for (const line of logs.since(sinceId(request, url))) send(line);
        const unsubscribe = logs.subscribe(send);
        const keepAlive = setInterval(() => response.write(": keep-alive\n\n"), 15_000);
        response.on("close", () => { unsubscribe(); clearInterval(keepAlive); });
        return;
      }
      if (request.method === "GET" && url.pathname === "/chatgpt") return sendJson(response, 200, await chatgptStatus());
      if (request.method === "POST" && url.pathname === "/chatgpt/login") return sendJson(response, 202, await requireChatGPT().startLogin());
      const loginMatch = url.pathname.match(/^\/chatgpt\/login\/([^/]+)$/);
      if (loginMatch && request.method === "GET") return sendJson(response, 200, await chatgptLogin(decodeURIComponent(loginMatch[1])));
      if (loginMatch && request.method === "DELETE") return sendJson(response, 200, await requireChatGPT().cancelLogin(decodeURIComponent(loginMatch[1])));
      if (request.method === "GET" && url.pathname === "/claude-desktop") return sendJson(response, 200, await claudeDesktopStatus(desktopGatewayUrl(), claudeDesktop));
      if (request.method === "POST" && url.pathname === "/claude-desktop/setup") {
        const result = await setupClaudeDesktop(desktopGatewayUrl(), models.list().map((model) => model.id), claudeDesktop);
        logs.push("info", `[claude-desktop] profile "${result.profileName}" → ${result.gatewayUrl}${result.wasRunning ? " · Claude Desktop quit" : ""}${result.relaunched ? " · relaunched" : ""}`);
        return sendJson(response, 200, result);
      }
      if (request.method === "POST" && url.pathname === "/claude-desktop/open") { await openClaudeDesktop(claudeDesktop); return sendJson(response, 200, { ok: true }); }
      if (request.method === "PUT" && url.pathname === "/claude-desktop/mode") {
        const { mode } = await jsonBody(request);
        if (mode !== "1p" && mode !== "3p") throw new GatewayError("INVALID_REQUEST", 'mode must be "1p" or "3p"', 400);
        const result = await setDeploymentMode(desktopGatewayUrl(), mode, claudeDesktop);
        logs.push("info", `[claude-desktop] deployment mode → ${mode}${result.wasRunning ? " · Claude Desktop quit" : ""}${result.relaunched ? " · relaunched" : ""}`);
        return sendJson(response, 200, result);
      }
      if (request.method === "GET" && url.pathname === "/models") {
        await refreshModels();
        return sendJson(response, 200, { models: models.list().map(({ providerOptions, ...model }) => model) });
      }
      const sessionMatch = url.pathname.match(/^\/sessions\/([^/]+)$/);
      if (request.method === "GET" && sessionMatch) {
        const session = await sessions.get(decodeURIComponent(sessionMatch[1]));
        return session ? sendJson(response, 200, session) : sendJson(response, 404, { error: "Session not found" });
      }
      if (request.method === "GET" && await serveStatic(url.pathname, response)) return;
      if (request.method !== "POST" || (url.pathname !== "/v1/messages" && url.pathname !== "/v1/chat/completions")) return sendJson(response, 404, { error: "Not found" });
      const body = await jsonBody(request); const explicitSession = request.headers["x-session-id"];
      const result = await gateway.handle(protocol, body, typeof explicitSession === "string" ? explicitSession : undefined, clientIdentityHeaders(request.headers));
      const headers = { "x-session-id": result.sessionId, "x-gateway-route": result.mode };
      if (!result.stream) return sendJson(response, 200, result.body, headers);
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", ...headers });
      Readable.from(result.events).pipe(response);
    } catch (error) {
      const normalized = normalizeError(error); sendJson(response, normalized.status, clientError(protocol, normalized));
    }
  });

  try {
    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => { server.off("error", reject); resolveListen(); });
    });
  } catch (error) { await chatgpt?.close().catch(() => {}); throw error; }
  const address = server.address();
  boundPort = typeof address === "object" && address ? address.port : port;
  logs.push("info", `AI gateway listening on http://${host}:${boundPort}`);
  if (chatgpt) logs.push("info", `[chatgpt] embedded backend on ${chatgpt.url}`);
  return {
    host, port: boundPort, url: `http://${host}:${boundPort}`, config, server, logs,
    close: async () => {
      await new Promise<void>((resolveClose, reject) => { server.closeAllConnections(); server.close((error) => error ? reject(error) : resolveClose()); });
      await chatgpt?.close();
    }
  };
}
