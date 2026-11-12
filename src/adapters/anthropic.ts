import type { CanonicalContentBlock, CanonicalMessage, CanonicalRequest, CanonicalResponse, CanonicalStreamEvent, GatewaySession, ModelProfile } from "../types.ts";
import type { ProviderAdapter } from "./provider.ts";
import { id, message, reasoningEffort, sse, textContent } from "./helpers.ts";
import { mapSettings } from "../settings.ts";
import { GatewayError } from "../errors.ts";

function parseBlocks(value: unknown): CanonicalContentBlock[] {
  if (typeof value === "string") return [{ type: "text", text: value }];
  if (!Array.isArray(value)) return [];
  return value.flatMap((block: any) => {
    if (block.type === "text") return [{ type: "text", text: String(block.text ?? "") } as CanonicalContentBlock];
    if (block.type === "image") return [{ type: "image", mediaType: block.source?.media_type, data: block.source?.data, url: block.source?.url } as CanonicalContentBlock];
    if (block.type === "tool_use") return [{ type: "tool_call", id: String(block.id), name: String(block.name), arguments: block.input ?? {} } as CanonicalContentBlock];
    if (block.type === "tool_result") return [{ type: "tool_result", toolCallId: String(block.tool_use_id), content: block.content, isError: block.is_error } as CanonicalContentBlock];
    return [];
  });
}

// Last-resort fallback for an upstream that cannot place tool_reference blocks where the API accepts
// them (Meridian's fresh-replay path does this when it cannot resume a session). Requests go upstream
// untouched; the gateway calls this only to retry a rejection, because flattening references unloads
// deferred tools for the rest of the turn. Returns the same object when nothing changes.
export function flattenToolReferences(body: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(body.messages)) return body;
  let changed = false;
  const flatten = (blocks: unknown): unknown => Array.isArray(blocks) ? blocks.map((block: any) => {
    if (block?.type === "tool_reference") { changed = true; return { type: "text", text: `Tool loaded: ${block.tool_name}` }; }
    if (block?.type === "tool_result" && Array.isArray(block.content)) return { ...block, content: flatten(block.content) };
    return block;
  }) : blocks;
  const messages = body.messages.map((item: any) => item ? { ...item, content: flatten(item.content) } : item);
  return changed ? { ...body, messages } : body;
}

function parseMessages(body: Record<string, unknown>): CanonicalMessage[] {
  const result: CanonicalMessage[] = [];
  if (body.system) result.push(message("system", parseBlocks(body.system)));
  for (const item of body.messages as any[] ?? []) if (item?.role === "user" || item?.role === "assistant") result.push(message(item.role, parseBlocks(item.content)));
  return result;
}

function thinkingEffort(value: unknown): CanonicalRequest["settings"]["reasoning"] {
  const thinking = value as { type?: string; budget_tokens?: number } | undefined;
  if (!thinking) return undefined;
  if (thinking.type === "disabled") return "none";
  if (thinking.type !== "enabled") return undefined;
  const budget = thinking.budget_tokens ?? 0;
  if (budget <= 1024) return "low";
  if (budget <= 4096) return "medium";
  if (budget <= 8192) return "high";
  return "xhigh";
}

// output_config.effort is what current Anthropic-protocol upstreams honor; a legacy thinking budget still maps to a tier.
const anthropicEffort = (body: Record<string, unknown>): CanonicalRequest["settings"]["reasoning"] =>
  reasoningEffort((body.output_config as { effort?: unknown } | undefined)?.effort) ?? thinkingEffort(body.thinking);

function buildBlocks(blocks: CanonicalContentBlock[]): Record<string, unknown>[] {
  return blocks.map((block) => {
    if (block.type === "text") return { type: "text", text: block.text };
    if (block.type === "image") return { type: "image", source: block.url ? { type: "url", url: block.url } : { type: "base64", media_type: block.mediaType, data: block.data } };
    if (block.type === "tool_call") return { type: "tool_use", id: block.id, name: block.name, input: block.arguments };
    return { type: "tool_result", tool_use_id: block.toolCallId, content: block.content, is_error: block.isError };
  });
}

function buildMessages(messages: CanonicalMessage[]): { system?: unknown; messages: Record<string, unknown>[] } {
  const instructions: string[] = [];
  const output: Record<string, unknown>[] = [];
  for (const item of messages) {
    if (item.role === "system") { instructions.push(textContent(item.content)); continue; }
    if (item.role === "developer") { instructions.push(`<developer-instruction>\n${textContent(item.content)}\n</developer-instruction>`); continue; }
    const role = item.role === "assistant" ? "assistant" : "user";
    const content = buildBlocks(item.content);
    const previous = output.at(-1);
    if (previous?.role === role) (previous.content as unknown[]).push(...content);
    else output.push({ role, content });
  }
  return { ...(instructions.length ? { system: instructions.join("\n\n") } : {}), messages: output };
}

export class AnthropicAdapter implements ProviderAdapter {
  readonly protocol = "anthropic" as const;
  parseIncomingRequest(body: Record<string, unknown>, sessionId: string): CanonicalRequest {
    if (!Array.isArray(body.messages)) throw new GatewayError("INVALID_REQUEST", "Anthropic request requires messages", 400);
    const tools = Array.isArray(body.tools) ? body.tools.map((tool: any) => ({ name: String(tool.name), description: tool.description, inputSchema: tool.input_schema ?? {} })) : [];
    const choice = body.tool_choice as any;
    return { sessionId, protocol: this.protocol, messages: parseMessages(body), tools, stream: body.stream === true, raw: body,
      settings: { temperature: body.temperature as number, maxOutputTokens: body.max_tokens as number, reasoning: anthropicEffort(body),
        toolChoice: choice?.type === "any" ? "required" : choice?.type === "auto" ? "auto" : undefined } };
  }
  buildUpstreamRequest(request: CanonicalRequest, session: GatewaySession, model: ModelProfile): Record<string, unknown> {
    const history = buildMessages(session.messages);
    return { model: model.upstreamModel, ...history, stream: request.stream,
      ...(request.raw.metadata !== undefined ? { metadata: request.raw.metadata } : {}),
      ...(request.tools.length ? { tools: request.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema })) } : {}),
      max_tokens: request.settings.maxOutputTokens ?? model.defaults?.maxOutputTokens ?? model.maxOutputTokens ?? 1024,
      ...mapSettings(this.protocol, request.settings, model) };
  }
  buildPassthroughRequest(body: Record<string, unknown>, model: ModelProfile): Record<string, unknown> {
    const choice = body.tool_choice as any;
    const settings = { temperature: body.temperature as number, maxOutputTokens: body.max_tokens as number, reasoning: anthropicEffort(body),
      toolChoice: choice?.type === "any" ? "required" as const : choice?.type === "auto" ? "auto" as const : undefined };
    const mapped = mapSettings(this.protocol, settings, model);
    if (body.thinking !== undefined || body.output_config !== undefined) delete mapped.output_config;
    return { ...body, model: model.upstreamModel, ...mapped };
  }
  normalizeUpstreamResponse(response: any): CanonicalResponse {
    if (!Array.isArray(response.content)) throw new GatewayError("PROTOCOL_TRANSLATION_ERROR", "Invalid Anthropic response", 502);
    return { id: String(response.id ?? id("msg")), message: message("assistant", parseBlocks(response.content)), stopReason: response.stop_reason,
      usage: { inputTokens: response.usage?.input_tokens, outputTokens: response.usage?.output_tokens } };
  }
  buildClientResponse(response: CanonicalResponse): Record<string, unknown> {
    return { id: response.id, type: "message", role: "assistant", content: buildBlocks(response.message.content), model: "gateway-selected-model",
      stop_reason: response.stopReason ?? "end_turn", stop_sequence: null,
      usage: { input_tokens: response.usage?.inputTokens ?? 0, output_tokens: response.usage?.outputTokens ?? 0 } };
  }
  translateStreamEvent(event: any, state: Record<string, unknown> = {}): CanonicalStreamEvent[] {
    if (event.type === "error") return [{ type: "error", error: { code: "UPSTREAM_UNAVAILABLE", message: event.error?.message ?? "Anthropic stream error", status: 502 } }];
    if (event.type === "message_start") return [{ type: "message_start", id: String(event.message?.id ?? id("msg")) }, ...(event.message?.usage ? [{ type: "usage", inputTokens: event.message.usage.input_tokens } as CanonicalStreamEvent] : [])];
    const toolIds = state.toolIds instanceof Map ? state.toolIds as Map<number, string> : (state.toolIds = new Map<number, string>()) as Map<number, string>;
    if (event.type === "content_block_start" && event.content_block?.type === "tool_use") { const callId = String(event.content_block.id); toolIds.set(Number(event.index), callId); return [{ type: "tool_call_start", id: callId, name: String(event.content_block.name) }]; }
    if (event.type === "content_block_delta" && event.delta?.type === "text_delta") return [{ type: "text_delta", text: String(event.delta.text) }];
    if (event.type === "content_block_delta" && event.delta?.type === "input_json_delta") return [{ type: "tool_call_delta", id: String(toolIds.get(Number(event.index)) ?? `call_${event.index}`), argumentsDelta: String(event.delta.partial_json) }];
    if (event.type === "content_block_stop" && toolIds.has(Number(event.index))) return [{ type: "tool_call_end", id: String(toolIds.get(Number(event.index))) }];
    if (event.type === "message_delta") {
      if (event.delta?.stop_reason) state.stopReason = String(event.delta.stop_reason);
      return [{ type: "usage", outputTokens: event.usage?.output_tokens }];
    }
    if (event.type === "message_stop") {
      if (state.messageEnded === true) return [];
      state.messageEnded = true;
      return [{ type: "message_end", reason: String(state.stopReason ?? "end_turn") }];
    }
    return [];
  }
  buildClientStreamEvents(event: CanonicalStreamEvent, state: Record<string, unknown> = {}): string[] {
    if (event.type === "message_start") return [sse({ type: "message_start", message: { id: event.id, type: "message", role: "assistant", content: [], usage: { input_tokens: 0, output_tokens: 0 } } }, "message_start")];
    const allocate = (): number => { const next = Number(state.nextIndex ?? 0); state.nextIndex = next + 1; return next; };
    const toolIndices = state.toolIndices instanceof Map ? state.toolIndices as Map<string, number> : (state.toolIndices = new Map<string, number>()) as Map<string, number>;
    if (event.type === "text_delta") {
      const frames: string[] = [];
      if (state.textIndex === undefined) { state.textIndex = allocate(); frames.push(sse({ type: "content_block_start", index: state.textIndex, content_block: { type: "text", text: "" } }, "content_block_start")); }
      frames.push(sse({ type: "content_block_delta", index: state.textIndex, delta: { type: "text_delta", text: event.text } }, "content_block_delta")); return frames;
    }
    if (event.type === "tool_call_start") { const index = allocate(); toolIndices.set(event.id, index); return [sse({ type: "content_block_start", index, content_block: { type: "tool_use", id: event.id, name: event.name, input: {} } }, "content_block_start")]; }
    if (event.type === "tool_call_delta") return [sse({ type: "content_block_delta", index: toolIndices.get(event.id) ?? 0, delta: { type: "input_json_delta", partial_json: event.argumentsDelta } }, "content_block_delta")];
    if (event.type === "tool_call_end") return [sse({ type: "content_block_stop", index: toolIndices.get(event.id) ?? 0 }, "content_block_stop")];
    if (event.type === "usage") return [sse({ type: "message_delta", delta: {}, usage: { output_tokens: event.outputTokens ?? 0 } }, "message_delta")];
    if (event.type === "message_end") { const frames: string[] = []; if (state.textIndex !== undefined) frames.push(sse({ type: "content_block_stop", index: state.textIndex }, "content_block_stop")); frames.push(sse({ type: "message_delta", delta: { stop_reason: event.reason ?? "end_turn", stop_sequence: null }, usage: { output_tokens: 0 } }, "message_delta"), sse({ type: "message_stop" }, "message_stop")); return frames; }
    if (event.type === "error") return [sse({ type: "error", error: { type: event.error.code.toLowerCase(), message: event.error.message } }, "error")];
    return [];
  }
}
