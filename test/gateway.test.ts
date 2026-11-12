import test from "node:test";
import assert from "node:assert/strict";
import { Gateway } from "../src/gateway.ts";
import { ModelRegistry } from "../src/models/registry.ts";
import { InMemorySessionStore } from "../src/sessions/store.ts";
import { SessionService } from "../src/sessions/service.ts";
import { RoutingService } from "../src/routing/service.ts";
import { AdapterRegistry } from "../src/adapters/provider.ts";
import { AnthropicAdapter, flattenToolReferences } from "../src/adapters/anthropic.ts";
import { OpenAIAdapter } from "../src/adapters/openai.ts";
import { clientIdentityHeaders, HttpProviderClient, type ProviderClient, type ProviderRequest } from "../src/providers/client.ts";
import type { ModelProfile, RouteObservation } from "../src/types.ts";
import { ContextManager } from "../src/context/manager.ts";
import { clientError, GatewayError } from "../src/errors.ts";
import type { Observer } from "../src/observability.ts";

const capabilities = { tools: true, vision: true, reasoning: true, streaming: true };
const modelData: ModelProfile[] = [
  { id: "claude", provider: "mtel", providerProtocol: "anthropic", upstreamModel: "claude-upstream", contextLimit: 10000, capabilities },
  { id: "claude-alt", provider: "mtel", providerProtocol: "anthropic", upstreamModel: "claude-alt-upstream", contextLimit: 10000, capabilities },
  { id: "gpt-anthropic", provider: "mtel", providerProtocol: "anthropic", upstreamModel: "gpt-anthropic-upstream", contextLimit: 10000, capabilities },
  { id: "gpt", provider: "mtel", providerProtocol: "openai", upstreamModel: "gpt-upstream", contextLimit: 10000, capabilities }
];

class FakeProviders implements ProviderClient {
  requests: ProviderRequest[] = [];
  responses: Record<string, unknown>[] = [];
  streamFactory?: () => AsyncIterable<Record<string, unknown>>;
  async complete(request: ProviderRequest): Promise<Record<string, unknown>> { this.requests.push(structuredClone(request)); return this.responses.shift()!; }
  async *stream(request: ProviderRequest): AsyncIterable<Record<string, unknown>> { this.requests.push(structuredClone(request)); if (this.streamFactory) yield* this.streamFactory(); }
}

function setup(defaultModel = "claude", observer?: Observer, profiles = modelData) {
  const models = new ModelRegistry(profiles); const store = new InMemorySessionStore(); const sessions = new SessionService(store); const routing = new RoutingService(models, defaultModel);
  const providers = new FakeProviders(); const adapters = new AdapterRegistry([new AnthropicAdapter(), new OpenAIAdapter()]);
  return { gateway: new Gateway(models, sessions, routing, adapters, providers, new ContextManager(), observer), providers, sessions, routing };
}
const anthropicResponse = (text: string, content: any[] = [{ type: "text", text }]) => ({ id: `a-${text}`, type: "message", role: "assistant", content, stop_reason: "end_turn", usage: { input_tokens: 3, output_tokens: 2 } });
const openaiResponse = (text: string) => ({ id: `o-${text}`, choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2 } });

test("same-provider Anthropic and OpenAI requests take passthrough path", async () => {
  const anthropic = setup("claude"); anthropic.providers.responses.push(anthropicResponse("hello"));
  const a = await anthropic.gateway.handle("anthropic", { model: "claude", messages: [{ role: "user", content: "hi" }], max_tokens: 20 }, "a");
  assert.equal(a.mode, "passthrough"); assert.equal(anthropic.providers.requests[0].body.model, "claude-upstream");

  const openai = setup("gpt"); openai.providers.responses.push(openaiResponse("hello"));
  const o = await openai.gateway.handle("openai", { model: "gpt", messages: [{ role: "user", content: "hi" }] }, "o");
  assert.equal(o.mode, "passthrough"); assert.equal(openai.providers.requests[0].body.model, "gpt-upstream");
});

test("cross-provider translation works in both directions", async () => {
  const toOpenAI = setup("gpt"); toOpenAI.providers.responses.push(openaiResponse("from gpt"));
  const a = await toOpenAI.gateway.handle("anthropic", { messages: [{ role: "user", content: "hi" }], max_tokens: 50 }, "cross-a");
  assert.equal(a.mode, "converted");
  assert.deepEqual(toOpenAI.providers.requests[0].body.messages, [{ role: "user", content: "hi" }]);
  assert.equal((a as any).body.content[0].text, "from gpt");

  const toAnthropic = setup("claude"); toAnthropic.providers.responses.push(anthropicResponse("from claude"));
  const o = await toAnthropic.gateway.handle("openai", { messages: [{ role: "developer", content: "be precise" }, { role: "user", content: "hi" }] }, "cross-o");
  assert.equal(o.mode, "converted");
  assert.match(String(toAnthropic.providers.requests[0].body.system), /developer-instruction/);
  assert.equal((o as any).body.choices[0].message.content, "from claude");
});

test("global Claude to GPT to Claude routing preserves logical session history", async () => {
  const { gateway, providers, sessions, routing } = setup();
  providers.responses.push(anthropicResponse("claude one"), openaiResponse("gpt two"), anthropicResponse("claude three"));
  await gateway.handle("anthropic", { messages: [{ role: "user", content: "one" }], max_tokens: 100 }, "switch");
  routing.update({ model: "gpt" });
  await gateway.handle("anthropic", { messages: [{ role: "user", content: "two" }], max_tokens: 100 }, "switch");
  assert.equal(providers.requests[1].providerId, "mtel"); assert.equal(providers.requests[1].protocol, "openai");
  assert.deepEqual((providers.requests[1].body.messages as any[]).map((m) => m.role), ["user", "assistant", "user"]);
  routing.update({ model: "claude" });
  await gateway.handle("anthropic", { messages: [{ role: "user", content: "three" }], max_tokens: 100 }, "switch");
  assert.equal(providers.requests[2].providerId, "mtel"); assert.equal(providers.requests[2].protocol, "anthropic");
  const session = await sessions.get("switch");
  assert.equal(routing.get().modelId, "claude"); assert.equal(session?.messages.length, 6);
});

test("tool call and result survive a provider switch with stable ID", async () => {
  const { gateway, providers, routing } = setup();
  providers.responses.push(anthropicResponse("", [{ type: "tool_use", id: "stable-call", name: "read_file", input: { path: "a.ts" } }]), openaiResponse("reviewed"));
  await gateway.handle("anthropic", { messages: [{ role: "user", content: "inspect" }], tools: [{ name: "read_file", input_schema: { type: "object" } }], max_tokens: 100 }, "tools");
  routing.update({ model: "gpt" });
  await gateway.handle("anthropic", { messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "stable-call", content: "file contents" }] }], tools: [{ name: "read_file", input_schema: { type: "object" } }], max_tokens: 100 }, "tools");
  const messages = providers.requests[1].body.messages as any[];
  assert.equal(messages[1].tool_calls[0].id, "stable-call"); assert.equal(messages[2].tool_call_id, "stable-call");
});

test("common reasoning settings map to the selected provider", async () => {
  const { gateway, providers } = setup("gpt"); providers.responses.push(openaiResponse("ok"));
  await gateway.handle("anthropic", { messages: [{ role: "user", content: "think" }], thinking: { type: "enabled", budget_tokens: 4000 }, max_tokens: 123 }, "settings");
  assert.equal(providers.requests[0].body.reasoning_effort, "medium"); assert.equal(providers.requests[0].body.max_completion_tokens, 123);
});

test("request model mismatch converts to the globally selected model without changing selection", async () => {
  const { gateway, providers, routing } = setup("claude"); providers.responses.push(anthropicResponse("selected claude"));
  const result = await gateway.handle("anthropic", { model: "gpt", messages: [{ role: "user", content: "use the proxy selection" }], max_tokens: 100 }, "authoritative-route");
  assert.equal(result.mode, "converted");
  assert.equal(providers.requests[0].protocol, "anthropic"); assert.equal(providers.requests[0].body.model, "claude-upstream");
  assert.equal(routing.get().modelId, "claude");
});

test("force-provider forwards a matching model-family prefix without replacing the model", async () => {
  const { gateway, providers, routing } = setup("claude"); providers.responses.push(anthropicResponse("requested model"));
  routing.update({ mode: "force-provider" });
  const result = await gateway.handle("anthropic", { model: "claude-fable-5.1", messages: [{ role: "user", content: "keep my model" }], max_tokens: 100 }, "provider-route");
  assert.equal(result.mode, "passthrough");
  assert.equal(providers.requests[0].protocol, "anthropic");
  assert.equal(providers.requests[0].body.model, "claude-fable-5.1");
});

test("force-provider converts a same-protocol request with a different model-family prefix", async () => {
  const { gateway, providers, routing } = setup("gpt-anthropic"); providers.responses.push(anthropicResponse("selected gpt"));
  routing.update({ mode: "force-provider" });
  const result = await gateway.handle("anthropic", { model: "claude-alt", messages: [{ role: "user", content: "convert me" }] }, "cross-provider-route");
  assert.equal(result.mode, "converted");
  assert.equal(providers.requests[0].providerId, "mtel");
  assert.equal(providers.requests[0].protocol, "anthropic");
  assert.equal(providers.requests[0].body.model, "gpt-anthropic-upstream");
});

test("force-provider preserves the requested capability tier across model families", async () => {
  const tierModels: ModelProfile[] = [
    ...modelData,
    { id: "gpt-6-astra", provider: "mtel", providerProtocol: "anthropic", upstreamModel: "gpt-6-astra", contextLimit: 10000, capabilities },
    { id: "gpt-5.6-sol", provider: "mtel", providerProtocol: "anthropic", upstreamModel: "gpt-5.6-sol", contextLimit: 10000, capabilities },
    { id: "gpt-5.6-terra", provider: "mtel", providerProtocol: "anthropic", upstreamModel: "gpt-5.6-terra", contextLimit: 10000, capabilities },
    { id: "gpt-6.1-sol", provider: "mtel", providerProtocol: "anthropic", upstreamModel: "gpt-6.1-sol", contextLimit: 10000, capabilities },
    { id: "gpt-6.1-terra", provider: "mtel", providerProtocol: "anthropic", upstreamModel: "gpt-6.1-terra", contextLimit: 10000, capabilities },
    { id: "claude-sonnet-5-5", provider: "mtel", providerProtocol: "anthropic", upstreamModel: "claude-sonnet-5-5", contextLimit: 10000, capabilities },
    { id: "claude-opus-5-5", provider: "mtel", providerProtocol: "anthropic", upstreamModel: "claude-opus-5-5", contextLimit: 10000, capabilities }
  ];
  const toGpt = setup("gpt-anthropic", undefined, tierModels); toGpt.providers.responses.push(anthropicResponse("frontier"));
  toGpt.routing.update({ mode: "force-provider" });
  await toGpt.gateway.handle("anthropic", { model: "claude-fable-5.1", messages: [{ role: "user", content: "hard task" }] });
  assert.equal(toGpt.providers.requests[0].body.model, "gpt-6-astra");

  const toClaude = setup("claude-sonnet-5-5", undefined, tierModels); toClaude.providers.responses.push(anthropicResponse("flagship"));
  toClaude.routing.update({ mode: "force-provider" });
  await toClaude.gateway.handle("anthropic", { model: "gpt-5.6-sol", messages: [{ role: "user", content: "complex task" }] });
  assert.equal(toClaude.providers.requests[0].body.model, "claude-opus-5-5");

  const pinned = setup("gpt-5.6-sol", undefined, tierModels); pinned.providers.responses.push(anthropicResponse("pinned"));
  pinned.routing.update({ mode: "force-provider" });
  await pinned.gateway.handle("anthropic", { model: "claude-opus-5-5", messages: [{ role: "user", content: "keep 5.6" }] });
  assert.equal(pinned.providers.requests[0].body.model, "gpt-5.6-sol");

  const pinnedBalanced = setup("gpt-5.6-sol", undefined, tierModels); pinnedBalanced.providers.responses.push(anthropicResponse("balanced"));
  pinnedBalanced.routing.update({ mode: "force-provider" });
  await pinnedBalanced.gateway.handle("anthropic", { model: "claude-sonnet-5-5", messages: [{ role: "user", content: "keep 5.6 Terra" }] });
  assert.equal(pinnedBalanced.providers.requests[0].body.model, "gpt-5.6-terra");

  const latest = setup("gpt-6.1-sol", undefined, tierModels); latest.providers.responses.push(anthropicResponse("latest"));
  latest.routing.update({ mode: "force-provider" });
  await latest.gateway.handle("anthropic", { model: "claude-opus-5-5", messages: [{ role: "user", content: "use 6.1" }] });
  assert.equal(latest.providers.requests[0].body.model, "gpt-6.1-sol");

  const fallback = setup("gpt-anthropic"); fallback.providers.responses.push(anthropicResponse("fallback"));
  fallback.routing.update({ mode: "force-provider" });
  await fallback.gateway.handle("anthropic", { model: "claude-fable-5-1", messages: [{ role: "user", content: "hard task" }] });
  assert.equal(fallback.providers.requests[0].body.model, "gpt-anthropic-upstream");
});

test("force-provider converts a request without the selected model-family prefix", async () => {
  const { gateway, providers, routing } = setup("claude"); providers.responses.push(anthropicResponse("selected claude"));
  routing.update({ mode: "force-provider" });
  const result = await gateway.handle("anthropic", { model: "unknown-model", messages: [{ role: "user", content: "convert me" }] }, "unknown-provider-route");
  assert.equal(result.mode, "converted");
  assert.equal(providers.requests[0].body.model, "claude-upstream");
});

test("request observation logs the incoming model without request or session IDs", async () => {
  const observations: RouteObservation[] = [];
  const { gateway, providers } = setup("claude", { record: (observation) => observations.push(observation) });
  providers.responses.push(anthropicResponse("selected claude"));

  await gateway.handle("anthropic", { model: "gpt", messages: [{ role: "user", content: "hello" }], max_tokens: 100 }, "private-session-id");

  assert.equal(observations.length, 1);
  assert.equal(observations[0].incomingModel, "gpt");
  assert.equal(observations[0].selectedModel, "claude");
  assert.equal("requestId" in observations[0], false);
  assert.equal("sessionId" in observations[0], false);
});

test("request observation keeps an explicit null when the incoming model is omitted", async () => {
  const observations: RouteObservation[] = [];
  const { gateway, providers } = setup("claude", { record: (observation) => observations.push(observation) });
  providers.responses.push(anthropicResponse("selected claude"));

  await gateway.handle("anthropic", { messages: [{ role: "user", content: "hello" }], max_tokens: 100 });

  assert.equal(observations[0].incomingModel, null);
});

test("global effort overrides request effort for the globally selected model", async () => {
  const { gateway, providers, routing } = setup("claude"); providers.responses.push(anthropicResponse("reasoned"));
  routing.update({ reasoningEffort: "xhigh" });
  await gateway.handle("openai", { model: "gpt", reasoning_effort: "low", messages: [{ role: "user", content: "analyze" }] }, "effort");
  assert.deepEqual(providers.requests[0].body.output_config, { effort: "xhigh" }); assert.equal(providers.requests[0].body.thinking, undefined);
  assert.equal(providers.requests[0].body.model, "claude-upstream"); assert.equal(routing.get().reasoningEffort, "xhigh");
});

test("native Anthropic thinking is preserved on passthrough", async () => {
  const { gateway, providers } = setup("claude"); providers.responses.push(anthropicResponse("reasoned"));
  const thinking = { type: "enabled", budget_tokens: 12000 };
  await gateway.handle("anthropic", { model: "claude", thinking, messages: [{ role: "user", content: "analyze" }], max_tokens: 100 }, "native-effort");
  assert.deepEqual(providers.requests[0].body.thinking, thinking); assert.equal(providers.requests[0].body.output_config, undefined);
});

test("stream forwards first delta before upstream completion and stores at boundary", async () => {
  const { gateway, providers, sessions } = setup("gpt");
  let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
  providers.streamFactory = async function* () {
    yield { id: "stream-1", choices: [{ delta: { role: "assistant" }, finish_reason: null }] };
    yield { id: "stream-1", choices: [{ delta: { content: "first" }, finish_reason: null }] };
    await gate;
    yield { id: "stream-1", choices: [{ delta: { content: " second" }, finish_reason: null }] };
    yield { id: "stream-1", choices: [{ delta: {}, finish_reason: "stop" }] };
  };
  const result = await gateway.handle("anthropic", { messages: [{ role: "user", content: "stream" }], stream: true, max_tokens: 20 }, "stream");
  assert.equal(result.stream, true); const iterator = (result as any).events[Symbol.asyncIterator]();
  const start = await iterator.next(); const blockStart = await iterator.next(); const first = await iterator.next();
  assert.match(start.value, /message_start/); assert.match(blockStart.value, /content_block_start/); assert.match(first.value, /first/);
  assert.equal((await sessions.get("stream"))?.messages.length, 1);
  release(); while (!(await iterator.next()).done) {}
  const stored = await sessions.get("stream"); assert.equal((stored?.messages[1].content[0] as any).text, "first second");
});

test("Anthropic stream emits one terminal sequence", async () => {
  const { gateway, providers, sessions } = setup("claude");
  providers.streamFactory = async function* () {
    yield { type: "message_start", message: { id: "stream-anthropic", usage: { input_tokens: 3 } } };
    yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } };
    yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "once" } };
    yield { type: "content_block_stop", index: 0 };
    yield { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } };
    yield { type: "message_stop" };
  };

  const result = await gateway.handle("anthropic", { model: "claude", messages: [{ role: "user", content: "stream" }], stream: true, max_tokens: 20 }, "anthropic-stream");
  const frames: string[] = [];
  for await (const frame of (result as any).events) frames.push(frame);

  assert.equal(frames.filter((frame) => frame.startsWith("event: message_stop\n")).length, 1);
  assert.equal(frames.filter((frame) => frame.startsWith("event: content_block_stop\n")).length, 1);
  const stored = await sessions.get("anthropic-stream");
  assert.equal((stored?.messages[1].content[0] as any).text, "once");
});

test("context limit and client error envelopes are normalized", async () => {
  const manager = new ContextManager();
  assert.throws(() => manager.assertFits({ id: "x", createdAt: new Date(), updatedAt: new Date(), messages: [{ id: "m", role: "user", content: [{ type: "text", text: "x".repeat(100) }] }] }, { ...modelData[0], id: "tiny", contextLimit: 1 }, 0), (error: any) => error.code === "CONTEXT_LIMIT");
  const error = new GatewayError("RATE_LIMIT", "slow down", 429, true);
  assert.equal((clientError("anthropic", error).error as any).type, "rate_limit"); assert.equal((clientError("openai", error).error as any).code, "RATE_LIMIT");
});

test("global routing validates models and supports clearing effort", () => {
  const models = new ModelRegistry(modelData); const routing = new RoutingService(models, "claude");
  assert.equal(models.list().length, 4);
  routing.update({ model: "gpt", reasoningEffort: "high" });
  assert.deepEqual({ model: routing.get().modelId, effort: routing.get().reasoningEffort }, { model: "gpt", effort: "high" });
  routing.update({ reasoningEffort: null }); assert.equal(routing.get().reasoningEffort, undefined);
  routing.update({ mode: "force-provider" }); assert.equal(routing.get().mode, "force-provider");
  assert.throws(() => routing.update({ model: "missing" }), (error: any) => error.code === "MODEL_NOT_FOUND");
  assert.throws(() => routing.update({ mode: "invalid" as any }), (error: any) => error.code === "INVALID_REQUEST");
  assert.throws(() => routing.update({ reasoningEffort: "extreme" as any }), (error: any) => error.code === "INVALID_REQUEST");
});

test("one MTEL provider dispatches both protocol-specific upstream routes", async () => {
  const calls: Array<{ url: string; headers: Headers }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), headers: new Headers(init?.headers) });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const client = new HttpProviderClient([{ id: "mtel", baseUrl: "https://mtel.example", apiKey: "secret", auth: "bearer", protocols: {
      anthropic: { path: "/anthropic/v1/messages", headers: { "anthropic-version": "2023-06-01" } },
      openai: { path: "/openai/v1/chat/completions" }
    } }]);
    await client.complete({ providerId: "mtel", protocol: "anthropic", body: {}, stream: false, headers: { "user-agent": "claude-cli/2.1.145 (external, cli)", "anthropic-version": "9999-01-01" } });
    await client.complete({ providerId: "mtel", protocol: "openai", body: {}, stream: false });
    assert.deepEqual(calls.map((call) => call.url), ["https://mtel.example/anthropic/v1/messages", "https://mtel.example/openai/v1/chat/completions"]);
    assert.equal(calls[0].headers.get("authorization"), "Bearer secret"); assert.equal(calls[0].headers.get("anthropic-version"), "2023-06-01");
    assert.equal(calls[1].headers.get("authorization"), "Bearer secret");
    assert.equal(calls[0].headers.get("user-agent"), "claude-cli/2.1.145 (external, cli)"); assert.equal(calls[1].headers.get("user-agent"), null);
  } finally { globalThis.fetch = originalFetch; }
});

test("tool_reference blocks reach the Anthropic upstream untouched; flattening is a retry-only helper", async () => {
  const { gateway, providers } = setup("claude"); providers.responses.push(anthropicResponse("ok"));
  const ref = { type: "tool_reference", tool_name: "Grep" };
  await gateway.handle("anthropic", { model: "claude", max_tokens: 20, messages: [
    { role: "user", content: [ref, { type: "text", text: "hi" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "ToolSearch", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [ref] }] },
    { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "ToolSearch", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: [ref] }] }
  ] }, "tool-ref");
  const sent = providers.requests[0].body.messages as any[]; const text = { type: "text", text: "Tool loaded: Grep" };
  assert.deepEqual(sent[0].content, [ref, { type: "text", text: "hi" }]);
  assert.deepEqual(sent[2].content[0].content, [ref]);
  assert.deepEqual(sent[4].content[0].content, [ref]);
  const flattened = flattenToolReferences(providers.requests[0].body).messages as any[];
  assert.deepEqual(flattened[0].content, [text, { type: "text", text: "hi" }]);
  assert.deepEqual(flattened[2].content[0].content, [text]);
  assert.deepEqual(flattened[4].content[0].content, [text]);
  const plain = { messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }] };
  assert.equal(flattenToolReferences(plain), plain);
});

test("a tool_reference rejection is retried once with every reference flattened", async () => {
  const ref = { type: "tool_reference", tool_name: "Grep" };
  const messages = [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [ref] }] }];
  const rejection = () => new GatewayError("UPSTREAM_UNAVAILABLE", "Upstream 500: messages.0.content.3: Input tag 'tool_reference' found", 500, true);

  const plain = setup("claude"); let calls = 0;
  plain.providers.complete = async (request) => { plain.providers.requests.push(structuredClone(request)); if (calls++ === 0) throw rejection(); return anthropicResponse("ok"); };
  const result = await plain.gateway.handle("anthropic", { model: "claude", max_tokens: 20, messages }, "retry");
  assert.equal((result as any).body.content[0].text, "ok"); assert.equal(plain.providers.requests.length, 2);
  assert.deepEqual((plain.providers.requests[0].body.messages as any[])[0].content[0].content, [ref]);
  assert.deepEqual((plain.providers.requests[1].body.messages as any[])[0].content[0].content, [{ type: "text", text: "Tool loaded: Grep" }]);

  const streamed = setup("claude"); let streams = 0;
  streamed.providers.stream = async function* (request) {
    streamed.providers.requests.push(structuredClone(request));
    if (streams++ === 0) throw rejection();
    yield { type: "message_start", message: { id: "s", usage: { input_tokens: 1 } } };
    yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } };
    yield { type: "message_stop" };
  };
  const stream = await streamed.gateway.handle("anthropic", { model: "claude", max_tokens: 20, stream: true, messages }, "retry-stream");
  const frames: string[] = []; for await (const frame of (stream as any).events) frames.push(frame);
  assert.equal(streamed.providers.requests.length, 2); assert.ok(frames.some((frame) => frame.includes("\"ok\""))); assert.ok(!frames.some((frame) => frame.startsWith("event: error")));

  const other = setup("claude");
  other.providers.complete = async () => { throw new GatewayError("RATE_LIMIT", "Upstream 429: slow down", 429, true); };
  await assert.rejects(other.gateway.handle("anthropic", { model: "claude", max_tokens: 20, messages }, "no-retry"), /429/);
});

test("client identity headers reach the provider; secrets and unrelated headers do not", async () => {
  const forwarded = clientIdentityHeaders({ "user-agent": "claude-cli/2.1.145 (external, cli)", "x-claude-code-agent-id": "agent-1", "x-claude-code-request-class": "auxiliary", "x-api-key": "secret", authorization: "Bearer secret", "x-session-id": "s", host: "127.0.0.1" });
  assert.deepEqual(forwarded, { "user-agent": "claude-cli/2.1.145 (external, cli)", "x-claude-code-agent-id": "agent-1", "x-claude-code-request-class": "auxiliary" });
  const { gateway, providers } = setup("claude"); providers.responses.push(anthropicResponse("ok"));
  await gateway.handle("anthropic", { model: "claude", max_tokens: 20, messages: [{ role: "user", content: "hi" }] }, "headers", forwarded);
  assert.deepEqual(providers.requests[0].headers, forwarded);
});

test("converted Anthropic requests keep metadata so upstream session identity survives", async () => {
  const { gateway, providers } = setup("claude"); providers.responses.push(anthropicResponse("ok"));
  const metadata = { user_id: JSON.stringify({ session_id: "sess-1" }) };
  const result = await gateway.handle("anthropic", { model: "gpt", metadata, max_tokens: 20, messages: [{ role: "user", content: "hi" }] }, "metadata");
  assert.equal(result.mode, "converted"); assert.deepEqual(providers.requests[0].body.metadata, metadata);
});

test("output_config.effort is the incoming Anthropic effort and is preserved on passthrough", async () => {
  const { gateway, providers, routing } = setup("claude"); providers.responses.push(anthropicResponse("ok"));
  routing.update({ reasoningEffort: "high" });
  const result = await gateway.handle("anthropic", { model: "claude", output_config: { effort: "high" }, max_tokens: 20, messages: [{ role: "user", content: "hi" }] }, "effort-config");
  assert.equal(result.mode, "passthrough"); assert.deepEqual(providers.requests[0].body.output_config, { effort: "high" }); assert.equal(providers.requests[0].body.thinking, undefined);
});
