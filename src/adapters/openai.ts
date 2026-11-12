import type { CanonicalContentBlock, CanonicalMessage, CanonicalRequest, CanonicalResponse, CanonicalStreamEvent, GatewaySession, ModelProfile } from "../types.ts";
import type { ProviderAdapter } from "./provider.ts";
import { id, jsonArguments, message, reasoningEffort, sse, textContent } from "./helpers.ts";
import { mapSettings } from "../settings.ts";
import { GatewayError } from "../errors.ts";

function parseContent(value: unknown): CanonicalContentBlock[] {
  if (typeof value === "string") return [{ type: "text", text: value }];
  if (!Array.isArray(value)) return [];
  return value.flatMap((part: any) => {
    if (part.type === "text" || part.type === "input_text" || part.type === "output_text") return [{ type: "text", text: String(part.text ?? "") } as CanonicalContentBlock];
    if (part.type === "image_url") return [{ type: "image", url: typeof part.image_url === "string" ? part.image_url : part.image_url?.url } as CanonicalContentBlock];
    return [];
  });
}

function parseMessage(item: any): CanonicalMessage[] {
  if (!item || typeof item !== "object") return [];
  if (item.role === "tool") return [message("user", [{ type: "tool_result", toolCallId: String(item.tool_call_id), content: item.content }])];
  if (!["system", "developer", "user", "assistant"].includes(item.role)) return [];
  const blocks = parseContent(item.content);
  if (item.role === "assistant" && Array.isArray(item.tool_calls)) for (const call of item.tool_calls) blocks.push({ type: "tool_call", id: String(call.id), name: String(call.function?.name), arguments: jsonArguments(call.function?.arguments) });
  return [message(item.role, blocks)];
}

function buildMessages(messages: CanonicalMessage[]): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  for (const item of messages) {
    const calls = item.content.filter((block) => block.type === "tool_call");
    const results = item.content.filter((block) => block.type === "tool_result");
    const regular = item.content.filter((block) => block.type === "text" || block.type === "image");
    if (regular.length || calls.length) {
      const content = regular.map((block) => block.type === "text" ? { type: "text", text: block.text } : { type: "image_url", image_url: { url: block.url ?? `data:${block.mediaType};base64,${block.data}` } });
      const out: Record<string, unknown> = { role: item.role, content: content.length === 1 && content[0].type === "text" ? (content[0] as any).text : content };
      if (calls.length) out.tool_calls = calls.map((block: any) => ({ id: block.id, type: "function", function: { name: block.name, arguments: typeof block.arguments === "string" ? block.arguments : JSON.stringify(block.arguments) } }));
      result.push(out);
    }
    for (const block of results as any[]) result.push({ role: "tool", tool_call_id: block.toolCallId, content: typeof block.content === "string" ? block.content : JSON.stringify(block.content) });
  }
  return result;
}

export class OpenAIAdapter implements ProviderAdapter {
  readonly protocol = "openai" as const;
  parseIncomingRequest(body: Record<string, unknown>, sessionId: string): CanonicalRequest {
    if (!Array.isArray(body.messages)) throw new GatewayError("INVALID_REQUEST", "OpenAI request requires messages", 400);
    const tools = Array.isArray(body.tools) ? body.tools.flatMap((tool: any) => tool?.type === "function" ? [{ name: String(tool.function.name), description: tool.function.description, inputSchema: tool.function.parameters ?? {} }] : []) : [];
    return { sessionId, protocol: this.protocol, messages: body.messages.flatMap(parseMessage), tools, stream: body.stream === true, raw: body,
      settings: { temperature: body.temperature as number, maxOutputTokens: (body.max_completion_tokens ?? body.max_tokens) as number, reasoning: reasoningEffort(body.reasoning_effort), toolChoice: typeof body.tool_choice === "string" ? body.tool_choice as any : undefined } };
  }
  buildUpstreamRequest(request: CanonicalRequest, session: GatewaySession, model: ModelProfile): Record<string, unknown> {
    return { model: model.upstreamModel, messages: buildMessages(session.messages), stream: request.stream,
      ...(request.tools.length ? { tools: request.tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })) } : {}),
      ...mapSettings(this.protocol, request.settings, model) };
  }
  buildPassthroughRequest(body: Record<string, unknown>, model: ModelProfile): Record<string, unknown> {
    const settings = { temperature: body.temperature as number, maxOutputTokens: (body.max_completion_tokens ?? body.max_tokens) as number, reasoning: reasoningEffort(body.reasoning_effort), toolChoice: typeof body.tool_choice === "string" ? body.tool_choice as any : undefined };
    return { ...body, model: model.upstreamModel, ...mapSettings(this.protocol, settings, model) };
  }
  normalizeUpstreamResponse(response: any): CanonicalResponse {
    const choice = response.choices?.[0];
    if (!choice?.message) throw new GatewayError("PROTOCOL_TRANSLATION_ERROR", "Invalid OpenAI response", 502);
    const blocks = parseContent(choice.message.content);
    for (const call of choice.message.tool_calls ?? []) blocks.push({ type: "tool_call", id: String(call.id), name: String(call.function?.name), arguments: jsonArguments(call.function?.arguments) });
    return { id: String(response.id ?? id("chatcmpl")), message: message("assistant", blocks), stopReason: choice.finish_reason,
      usage: { inputTokens: response.usage?.prompt_tokens, outputTokens: response.usage?.completion_tokens } };
  }
  buildClientResponse(response: CanonicalResponse): Record<string, unknown> {
    const calls = response.message.content.filter((b) => b.type === "tool_call") as any[];
    return { id: response.id, object: "chat.completion", created: Math.floor(Date.now() / 1000), choices: [{ index: 0, message: { role: "assistant", content: textContent(response.message.content) || null,
      ...(calls.length ? { tool_calls: calls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments) } })) } : {}) }, finish_reason: response.stopReason ?? "stop" }],
      usage: { prompt_tokens: response.usage?.inputTokens ?? 0, completion_tokens: response.usage?.outputTokens ?? 0, total_tokens: (response.usage?.inputTokens ?? 0) + (response.usage?.outputTokens ?? 0) } };
  }
  translateStreamEvent(event: any, state: Record<string, unknown> = {}): CanonicalStreamEvent[] {
    if (event.error) return [{ type: "error", error: { code: "UPSTREAM_UNAVAILABLE", message: event.error.message ?? "OpenAI stream error", status: 502 } }];
    const choice = event.choices?.[0]; const delta = choice?.delta; const events: CanonicalStreamEvent[] = [];
    if (event.id && delta?.role) events.push({ type: "message_start", id: String(event.id) });
    if (delta?.content) events.push({ type: "text_delta", text: String(delta.content) });
    const toolIds = state.toolIds instanceof Map ? state.toolIds as Map<number, string> : (state.toolIds = new Map<number, string>()) as Map<number, string>;
    for (const call of delta?.tool_calls ?? []) {
      const index = Number(call.index ?? 0); const callId = String(call.id ?? toolIds.get(index) ?? `call_${index}`);
      if (call.id) toolIds.set(index, callId);
      if (call.id || call.function?.name) events.push({ type: "tool_call_start", id: callId, name: String(call.function?.name ?? "") });
      if (call.function?.arguments) events.push({ type: "tool_call_delta", id: callId, argumentsDelta: String(call.function.arguments) });
    }
    if (event.usage) events.push({ type: "usage", inputTokens: event.usage.prompt_tokens, outputTokens: event.usage.completion_tokens });
    if (choice?.finish_reason) events.push({ type: "message_end", reason: choice.finish_reason });
    return events;
  }
  buildClientStreamEvents(event: CanonicalStreamEvent): string[] {
    if (event.type === "message_start") return [sse({ id: event.id, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })];
    if (event.type === "text_delta") return [sse({ object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: event.text }, finish_reason: null }] })];
    if (event.type === "tool_call_start") return [sse({ object: "chat.completion.chunk", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: event.id, type: "function", function: { name: event.name, arguments: "" } }] }, finish_reason: null }] })];
    if (event.type === "tool_call_delta") return [sse({ object: "chat.completion.chunk", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: event.id, function: { arguments: event.argumentsDelta } }] }, finish_reason: null }] })];
    if (event.type === "usage") return [sse({ choices: [], usage: { prompt_tokens: event.inputTokens, completion_tokens: event.outputTokens } })];
    if (event.type === "message_end") return [sse({ object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: event.reason ?? "stop" }] }), sse("[DONE]")];
    if (event.type === "error") return [sse({ error: event.error })];
    return [];
  }
}
