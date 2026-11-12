import type { CanonicalGatewayError, GatewayErrorCode, Protocol } from "./types.ts";

export class GatewayError extends Error {
  constructor(public code: GatewayErrorCode, message: string, public status = 500, public retryable = false) { super(message); }
  canonical(): CanonicalGatewayError { return { code: this.code, message: this.message, status: this.status, retryable: this.retryable }; }
}

export function normalizeError(error: unknown): GatewayError {
  if (error instanceof GatewayError) return error;
  if (error instanceof DOMException && error.name === "AbortError") return new GatewayError("UPSTREAM_TIMEOUT", "Upstream request timed out", 504, true);
  return new GatewayError("UPSTREAM_UNAVAILABLE", error instanceof Error ? error.message : "Unknown upstream error", 502, true);
}

export function clientError(protocol: Protocol, error: GatewayError): Record<string, unknown> {
  if (protocol === "anthropic") return { type: "error", error: { type: error.code.toLowerCase(), message: error.message } };
  return { error: { message: error.message, type: error.code.toLowerCase(), code: error.code } };
}
