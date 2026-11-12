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
export const reasoningEffort = (value: unknown): CommonModelSettings["reasoning"] =>
  typeof value === "string" && ["none", "low", "medium", "high", "xhigh"].includes(value) ? value as CommonModelSettings["reasoning"] : undefined;
export const settingsWithDefaults = (request: CommonModelSettings, defaults: CommonModelSettings = {}): CommonModelSettings => ({ ...defaults, ...Object.fromEntries(Object.entries(request).filter(([, value]) => value !== undefined)) });
export const sse = (data: unknown, event?: string): string => `${event ? `event: ${event}\n` : ""}data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`;
