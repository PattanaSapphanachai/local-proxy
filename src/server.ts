import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { loadConfig } from "./config.ts";
import { ModelRegistry } from "./models/registry.ts";
import { InMemorySessionStore } from "./sessions/store.ts";
import { SessionService } from "./sessions/service.ts";
import { loadRoutingState, RoutingService, saveRoutingState } from "./routing/service.ts";
import { AdapterRegistry } from "./adapters/provider.ts";
import { AnthropicAdapter } from "./adapters/anthropic.ts";
import { OpenAIAdapter } from "./adapters/openai.ts";
import { clientIdentityHeaders, HttpProviderClient } from "./providers/client.ts";
import { JsonConsoleObserver } from "./observability.ts";
import { Gateway } from "./gateway.ts";
import { clientError, normalizeError } from "./errors.ts";
import type { Protocol, RoutingMode } from "./types.ts";

async function jsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > 20 * 1024 * 1024) throw new Error("Request body exceeds 20MB"); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
const sendJson = (response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  response.writeHead(status, { "content-type": "application/json", ...headers }); response.end(JSON.stringify(body));
};

const config = await loadConfig();
const models = new ModelRegistry(config.models); const store = new InMemorySessionStore();
const sessions = new SessionService(store); const routing = new RoutingService(models, config.defaultModel);
const routingStatePath = process.env.GATEWAY_STATE ?? ".gateway-state.json";
try {
  const savedRoute = await loadRoutingState(routingStatePath);
  if (savedRoute) routing.update(savedRoute);
} catch (error) { console.warn(`[routing-state] Could not restore: ${error instanceof Error ? error.message : String(error)}`); }
const gateway = new Gateway(models, sessions, routing, new AdapterRegistry([new AnthropicAdapter(), new OpenAIAdapter()]), new HttpProviderClient(config.providers), undefined, new JsonConsoleObserver());
const startedAt = new Date();

async function refreshModels() {
  models.replace(await config.refreshModels());
  if (!models.has(routing.get().modelId)) await saveRoutingState(routingStatePath, routing.update({ model: config.defaultModel }));
}

function routingStatus() {
  const route = routing.get(); const model = models.get(route.modelId);
  return { mode: route.mode, model: model.id, reasoningEffort: route.reasoningEffort ?? null, provider: model.provider, upstreamProtocol: model.providerProtocol, upstreamModel: model.upstreamModel, updatedAt: route.updatedAt };
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  let protocol: Protocol = url.pathname === "/v1/messages" ? "anthropic" : "openai";
  try {
    if (request.method === "GET" && url.pathname === "/health") return sendJson(response, 200, { ok: true });
    if (request.method === "GET" && url.pathname === "/status") return sendJson(response, 200, { ok: true, startedAt, uptimeSeconds: Math.floor(process.uptime()), routing: routingStatus(), modelCount: models.list().length });
    if (request.method === "GET" && url.pathname === "/routing") return sendJson(response, 200, routingStatus());
    if (request.method === "PUT" && url.pathname === "/routing") {
      const body = await jsonBody(request);
      const previous = routing.get();
      const updated = routing.update({ model: typeof body.model === "string" ? body.model : undefined, mode: body.mode as RoutingMode | undefined, reasoningEffort: body.reasoningEffort as any });
      try { await saveRoutingState(routingStatePath, updated); }
      catch (error) { routing.update({ model: previous.modelId, mode: previous.mode, reasoningEffort: previous.reasoningEffort ?? null }); throw error; }
      return sendJson(response, 200, routingStatus());
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

server.listen(config.port, config.host, () => console.log(`AI gateway listening on http://${config.host}:${config.port}`));
