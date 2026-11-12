import { randomUUID } from "node:crypto";
import type { CanonicalContentBlock, CanonicalMessage, CanonicalStreamEvent, Protocol, RouteObservation } from "./types.ts";
import { ModelRegistry } from "./models/registry.ts";
import { SessionService } from "./sessions/service.ts";
import { RoutingService } from "./routing/service.ts";
import { AdapterRegistry } from "./adapters/provider.ts";
import { flattenToolReferences } from "./adapters/anthropic.ts";
import type { ProviderClient } from "./providers/client.ts";
import { ContextManager } from "./context/manager.ts";
import type { Observer } from "./observability.ts";
import { NoopObserver } from "./observability.ts";
import { GatewayError, normalizeError } from "./errors.ts";

export type GatewayResult =
  | { stream: false; sessionId: string; mode: "passthrough" | "converted"; body: Record<string, unknown> }
  | { stream: true; sessionId: string; mode: "passthrough" | "converted"; events: AsyncIterable<string> };

const comparable = (messages: CanonicalMessage[]): string => JSON.stringify(messages.map(({ role, content }) => ({ role, content })));
const modelFamily = (model: string): string => model.split("-", 1)[0].toLowerCase();
type ModelTier = "frontier" | "flagship" | "balanced" | "efficient";
const modelTier = (model: string): ModelTier | undefined => {
  const id = model.toLowerCase();
  if (/^claude-fable-|^gpt-\d+(?:\.\d+)?-astra(?:-|$)/.test(id)) return "frontier";
  if (/^claude-opus-|^gpt-\d+(?:\.\d+)?-sol(?:-|$)|^gpt-(?:5\.5|5\.6)$/.test(id)) return "flagship";
  if (/^claude-sonnet-|^gpt-\d+(?:\.\d+)?-terra(?:-|$)/.test(id)) return "balanced";
  if (/^claude-haiku-|^gpt-\d+(?:\.\d+)?-luna(?:-|$)/.test(id)) return "efficient";
};
const modelSeries = (model: string): string | undefined => {
  const id = model.toLowerCase();
  const claude = id.match(/^claude-(?:fable|opus|sonnet|haiku)-(\d+)/);
  if (claude) return `claude-${claude[1]}`;
  const gpt = id.match(/^gpt-(\d+)(?:\.(\d+))?(?:-|$)/);
  if (!gpt) return undefined;
  return gpt[1] === "6" ? "gpt-6" : `gpt-${gpt[1]}${gpt[2] ? `.${gpt[2]}` : ""}`;
};

class StreamAccumulator {
  id = `msg_${randomUUID()}`; blocks: CanonicalContentBlock[] = []; usage: { inputTokens?: number; outputTokens?: number } = {}; reason?: string;
  readonly #tools = new Map<string, { block: Extract<CanonicalContentBlock, { type: "tool_call" }>; json: string }>();
  add(event: CanonicalStreamEvent): void {
    if (event.type === "message_start") this.id = event.id;
    else if (event.type === "text_delta") { const last = this.blocks.at(-1); if (last?.type === "text") last.text += event.text; else this.blocks.push({ type: "text", text: event.text }); }
    else if (event.type === "tool_call_start") { const block = { type: "tool_call" as const, id: event.id, name: event.name, arguments: {} }; this.blocks.push(block); this.#tools.set(event.id, { block, json: "" }); }
    else if (event.type === "tool_call_delta") { const tool = this.#tools.get(event.id) ?? [...this.#tools.values()].at(-1); if (tool) tool.json += event.argumentsDelta; }
    else if (event.type === "tool_call_end") { const tool = this.#tools.get(event.id) ?? [...this.#tools.values()].at(-1); if (tool) { try { tool.block.arguments = JSON.parse(tool.json || "{}"); } catch { tool.block.arguments = tool.json; } } }
    else if (event.type === "usage") this.usage = { inputTokens: event.inputTokens ?? this.usage.inputTokens, outputTokens: event.outputTokens ?? this.usage.outputTokens };
    else if (event.type === "message_end") this.reason = event.reason;
  }
  message(): CanonicalMessage { for (const tool of this.#tools.values()) if (tool.json && Object.keys(tool.block.arguments as object).length === 0) { try { tool.block.arguments = JSON.parse(tool.json); } catch { tool.block.arguments = tool.json; } } return { id: this.id, role: "assistant", content: this.blocks, createdAt: new Date() }; }
}

export class Gateway {
  constructor(private models: ModelRegistry, private sessions: SessionService, private routing: RoutingService, private adapters: AdapterRegistry, private providers: ProviderClient,
    private context = new ContextManager(), private observer: Observer = new NoopObserver()) {}

  async handle(protocol: Protocol, body: Record<string, unknown>, sessionId?: string, clientHeaders: Record<string, string> = {}): Promise<GatewayResult> {
    const started = performance.now();
    const clientAdapter = this.adapters.get(protocol);
    const session = await this.sessions.resolve(sessionId);
    const parsed = clientAdapter.parseIncomingRequest(body, session.id);
    const before = comparable(session.messages); const incoming = comparable(parsed.messages);
    const merged = await this.sessions.mergeIncoming(session, parsed.messages);
    const route = this.routing.get();
    const selectedModel = this.models.get(route.modelId);
    const requestedModel = typeof body.model === "string" && body.model ? body.model : undefined;
    const requestedTier = requestedModel && modelTier(requestedModel);
    const selectedFamily = modelFamily(selectedModel.upstreamModel);
    const selectedSeries = modelSeries(selectedModel.upstreamModel);
    const tierModel = route.mode === "force-provider" && requestedTier && requestedModel && modelFamily(requestedModel) !== selectedFamily
      ? this.models.list().filter((candidate) => modelFamily(candidate.upstreamModel) === selectedFamily && modelTier(candidate.upstreamModel) === requestedTier
          && (requestedTier === "frontier" || modelSeries(candidate.upstreamModel) === selectedSeries))
        .sort((a, b) => b.upstreamModel.localeCompare(a.upstreamModel, undefined, { numeric: true }))[0]
      : undefined;
    const model = tierModel ?? selectedModel; const targetAdapter = this.adapters.get(model.providerProtocol);
    const incomingEffort = parsed.settings.reasoning;
    const effortMatches = route.reasoningEffort === undefined || incomingEffort === route.reasoningEffort;
    const forceProviderPassthrough = route.mode === "force-provider" && requestedModel !== undefined && modelFamily(requestedModel) === selectedFamily && protocol === selectedModel.providerProtocol;
    if (!forceProviderPassthrough && route.reasoningEffort !== undefined) parsed.settings.reasoning = route.reasoningEffort;
    this.context.assertFits(merged, model, parsed.settings.maxOutputTokens ?? model.maxOutputTokens ?? 0);
    const completeIncomingHistory = before === "[]" || before === incoming || comparable(merged.messages) === incoming;
    const modelMatches = requestedModel === undefined || requestedModel === model.id || requestedModel === model.upstreamModel;
    const mode = forceProviderPassthrough || (protocol === model.providerProtocol && modelMatches && effortMatches && completeIncomingHistory) ? "passthrough" : "converted";
    const upstreamBody = forceProviderPassthrough ? structuredClone(body) : mode === "passthrough" ? clientAdapter.buildPassthroughRequest(body, model) : targetAdapter.buildUpstreamRequest(parsed, merged, model);
    // Safety net only: an upstream that replays history (Meridian without a resumable session) can reject
    // tool_reference blocks. Retry such a rejection once with every reference flattened to text, and say so.
    const retryBody = model.providerProtocol === "anthropic" ? flattenToolReferences(upstreamBody) : upstreamBody;
    const rejectsToolReference = (error: unknown): boolean => retryBody !== upstreamBody && error instanceof GatewayError && error.message.includes("tool_reference");
    const logRetry = () => console.warn("[tool-reference] upstream rejected tool_reference blocks; retrying once with all of them as text. Frequent retries mean the upstream is not resuming sessions.");
    const observation: RouteObservation = { incomingProtocol: protocol, incomingModel: requestedModel ?? null, selectedModel: model.id, upstreamProvider: model.provider, upstreamModel: forceProviderPassthrough ? requestedModel ?? model.upstreamModel : model.upstreamModel, mode };
    try {
      if (!parsed.stream) {
        const complete = (body: Record<string, unknown>) => this.providers.complete({ providerId: model.provider, protocol: model.providerProtocol, body, stream: false, headers: clientHeaders });
        let raw: Record<string, unknown>;
        try { raw = await complete(upstreamBody); }
        catch (error) { if (!rejectsToolReference(error)) throw error; logRetry(); raw = await complete(retryBody); }
        const canonical = targetAdapter.normalizeUpstreamResponse(raw); await this.sessions.appendAssistant(merged.id, canonical.message);
        Object.assign(observation, { latencyMs: performance.now() - started, inputTokens: canonical.usage?.inputTokens, outputTokens: canonical.usage?.outputTokens, toolCalls: canonical.message.content.filter((b) => b.type === "tool_call").length });
        this.observer.record(observation);
        return { stream: false, sessionId: merged.id, mode, body: mode === "passthrough" ? raw : clientAdapter.buildClientResponse(canonical) };
      }
      const self = this;
      async function* upstreamEvents(): AsyncIterable<Record<string, unknown>> {
        let received = false;
        try { for await (const event of self.providers.stream({ providerId: model.provider, protocol: model.providerProtocol, body: upstreamBody, stream: true, headers: clientHeaders })) { received = true; yield event; } }
        catch (error) {
          if (received || !rejectsToolReference(error)) throw error;
          logRetry(); yield* self.providers.stream({ providerId: model.provider, protocol: model.providerProtocol, body: retryBody, stream: true, headers: clientHeaders });
        }
      }
      async function* translate(): AsyncIterable<string> {
        const accumulator = new StreamAccumulator(); let firstToken: number | undefined;
        const upstreamState: Record<string, unknown> = {}; const clientState: Record<string, unknown> = {};
        try {
          for await (const nativeEvent of upstreamEvents()) {
            for (const event of targetAdapter.translateStreamEvent(nativeEvent, upstreamState)) {
              if (firstToken === undefined && (event.type === "text_delta" || event.type === "tool_call_start")) firstToken = performance.now();
              accumulator.add(event); for (const frame of clientAdapter.buildClientStreamEvents(event, clientState)) yield frame;
            }
          }
          await self.sessions.appendAssistant(merged.id, accumulator.message());
          Object.assign(observation, { latencyMs: performance.now() - started, timeToFirstTokenMs: firstToken === undefined ? undefined : firstToken - started,
            inputTokens: accumulator.usage.inputTokens, outputTokens: accumulator.usage.outputTokens, toolCalls: accumulator.blocks.filter((b) => b.type === "tool_call").length });
          self.observer.record(observation);
        } catch (error) { const normalized = normalizeError(error); observation.error = normalized.code; self.observer.record(observation); for (const frame of clientAdapter.buildClientStreamEvents({ type: "error", error: normalized.canonical() }, clientState)) yield frame; }
      }
      return { stream: true, sessionId: merged.id, mode, events: translate() };
    } catch (error) { const normalized = normalizeError(error); observation.error = normalized.code; observation.latencyMs = performance.now() - started; this.observer.record(observation); throw normalized; }
  }
}
