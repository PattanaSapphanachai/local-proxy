import type { CommonModelSettings, ModelProfile, Protocol } from "./types.ts";
import { settingsWithDefaults } from "./adapters/helpers.ts";

export function mapSettings(protocol: Protocol, settings: CommonModelSettings, model: ModelProfile): Record<string, unknown> {
  const merged = settingsWithDefaults(settings, model.defaults);
  const result: Record<string, unknown> = {};
  if (merged.temperature !== undefined) result.temperature = merged.temperature;
  if (merged.maxOutputTokens !== undefined) result[protocol === "anthropic" ? "max_tokens" : "max_completion_tokens"] = merged.maxOutputTokens;
  if (merged.toolChoice) {
    if (protocol === "openai") result.tool_choice = merged.toolChoice === "required" ? "required" : merged.toolChoice;
    else if (merged.toolChoice !== "none") result.tool_choice = { type: merged.toolChoice === "required" ? "any" : "auto" };
  }
  if (merged.reasoning && merged.reasoning !== "none" && model.capabilities.reasoning) {
    if (protocol === "openai") result.reasoning_effort = merged.reasoning;
    else result.output_config = { effort: merged.reasoning };
  }
  const overrides = model.providerOptions?.[protocol];
  return { ...result, ...(typeof overrides === "object" && overrides ? overrides as Record<string, unknown> : {}) };
}
