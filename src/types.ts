export type Protocol = "anthropic" | "openai";
export type RoutingMode = "force-model" | "force-provider";
export type ProviderId = string;
export type CanonicalRole = "system" | "developer" | "user" | "assistant";

export interface CanonicalTextBlock { type: "text"; text: string }
export interface CanonicalImageBlock { type: "image"; mediaType?: string; data?: string; url?: string }
export interface CanonicalToolCall { type: "tool_call"; id: string; name: string; arguments: unknown }
export interface CanonicalToolResult { type: "tool_result"; toolCallId: string; content: unknown; isError?: boolean }
export type CanonicalContentBlock = CanonicalTextBlock | CanonicalImageBlock | CanonicalToolCall | CanonicalToolResult;

export interface CanonicalMessage {
  id: string;
  role: CanonicalRole;
  content: CanonicalContentBlock[];
  createdAt?: Date;
}

export interface CanonicalToolDefinition { name: string; description?: string; inputSchema: unknown }
export interface CommonModelSettings {
  reasoning?: "none" | "low" | "medium" | "high" | "xhigh";
  temperature?: number;
  maxOutputTokens?: number;
  toolChoice?: "auto" | "none" | "required";
}

export interface CanonicalRequest {
  sessionId: string;
  protocol: Protocol;
  messages: CanonicalMessage[];
  tools: CanonicalToolDefinition[];
  settings: CommonModelSettings;
  stream: boolean;
  raw: Record<string, unknown>;
}

export interface CanonicalResponse {
  id: string;
  message: CanonicalMessage;
  stopReason?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export type CanonicalStreamEvent =
  | { type: "message_start"; id: string }
  | { type: "text_delta"; text: string }
  | { type: "tool_call_start"; id: string; name: string }
  | { type: "tool_call_delta"; id: string; argumentsDelta: string }
  | { type: "tool_call_end"; id: string }
  | { type: "usage"; inputTokens?: number; outputTokens?: number }
  | { type: "message_end"; reason?: string }
  | { type: "error"; error: CanonicalGatewayError };

export interface ModelCapabilities { tools: boolean; vision: boolean; reasoning: boolean; streaming: boolean }
export interface ModelProfile {
  id: string;
  provider: ProviderId;
  providerProtocol: Protocol;
  upstreamModel: string;
  contextLimit?: number;
  maxOutputTokens?: number;
  capabilities: ModelCapabilities;
  defaults?: CommonModelSettings;
  providerOptions?: Record<string, unknown>;
}

export interface GatewaySession {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  messages: CanonicalMessage[];
  checkpoints?: ContextCheckpoint[];
  metadata?: Record<string, unknown>;
}

export interface GatewayRoute {
  modelId: string;
  mode: RoutingMode;
  reasoningEffort?: CommonModelSettings["reasoning"];
  updatedAt: Date;
}

export interface ContextCheckpoint { createdAt: Date; throughMessageId: string; summary: string }

export type GatewayErrorCode = "AUTHENTICATION_ERROR" | "RATE_LIMIT" | "MODEL_NOT_FOUND" | "CONTEXT_LIMIT" | "INVALID_REQUEST" | "TOOL_ERROR" | "UPSTREAM_TIMEOUT" | "UPSTREAM_UNAVAILABLE" | "PROTOCOL_TRANSLATION_ERROR";
export interface CanonicalGatewayError { code: GatewayErrorCode; message: string; status: number; retryable?: boolean }

export interface RouteObservation {
  incomingProtocol: Protocol; incomingModel: string | null; selectedModel: string;
  upstreamProvider: string; upstreamModel: string; mode: "passthrough" | "converted";
  latencyMs?: number; timeToFirstTokenMs?: number; inputTokens?: number; outputTokens?: number;
  toolCalls?: number; compacted?: boolean; error?: string;
}
