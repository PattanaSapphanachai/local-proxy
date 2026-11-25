import { randomUUID } from "node:crypto";
import type { CanonicalContentBlock, CanonicalMessage, CanonicalRole, CommonModelSettings } from "../types.ts";

export const id = (prefix = "msg"): string => `${prefix}_${randomUUID()}`;
export const message = (role: CanonicalRole, content: CanonicalContentBlock[]): CanonicalMessage => ({ id: id(), role, content, createdAt: new Date() });
export const textBlocks = (value: unknown): CanonicalContentBlock[] => {
  if (typeof value === "string") return [{ type: "text", text: value }];
  return [];
};
export const textContent = (blocks: CanonicalContentBlock[]): string => blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
export const jsonArguments = (value: unknown): unknown => {
  if (typeof value !== "string") return value ?? {};
  try { return JSON.parse(value); } catch { return value; }
};
export const stopSequences = (value: unknown): string[] | undefined => {
  const list = (typeof value === "string" ? [value] : Array.isArray(value) ? value : []).filter((item): item is string => typeof item === "string" && item.length > 0);
  return list.length ? list : undefined;
};
export const reasoningEffort =(value: unknown): CommonModelSettings["reasoning"] =>
  typeof value === "string" && ["none", "low", "medium", "high", "xhigh"].includes(value) ? value as CommonModelSettings["reasoning"] : undefined;
export const settingsWithDefaults = (request: CommonModelSettings, defaults: CommonModelSettings = {}): CommonModelSettings => ({ ...defaults, ...Object.fromEntries(Object.entries(request).filter(([, value]) => value !== undefined)) });
// Stop reasons are stored as the upstream sent them and translated only when building a client response.
const ANTHROPIC_STOP: Record<string, string> = { stop: "end_turn", tool_calls: "tool_use", function_call: "tool_use", length: "max_tokens", content_filter: "refusal" };
const OPENAI_STOP: Record<string, string> = { end_turn: "stop", stop_sequence: "stop", pause_turn: "stop", tool_use: "tool_calls", max_tokens: "length", refusal: "content_filter" };
export const anthropicStopReason = (reason?: string): string => reason ? ANTHROPIC_STOP[reason] ?? reason : "end_turn";
export const openaiFinishReason = (reason?: string): string => reason ? OPENAI_STOP[reason] ?? reason : "stop";
export const sse = (data: unknown, event?: string): string => `${event ? `event: ${event}\n` : ""}data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`;
