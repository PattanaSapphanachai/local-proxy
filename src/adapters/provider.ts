import type { CanonicalRequest, CanonicalResponse, CanonicalStreamEvent, GatewaySession, ModelProfile, Protocol } from "../types.ts";

export interface ProviderAdapter {
  readonly protocol: Protocol;
  parseIncomingRequest(body: Record<string, unknown>, sessionId: string): CanonicalRequest;
  buildUpstreamRequest(request: CanonicalRequest, session: GatewaySession, model: ModelProfile): Record<string, unknown>;
  buildPassthroughRequest(body: Record<string, unknown>, model: ModelProfile): Record<string, unknown>;
  normalizeUpstreamResponse(response: Record<string, unknown>): CanonicalResponse;
  buildClientResponse(response: CanonicalResponse): Record<string, unknown>;
  translateStreamEvent(event: Record<string, unknown>, state?: Record<string, unknown>): CanonicalStreamEvent[];
  buildClientStreamEvents(event: CanonicalStreamEvent, state?: Record<string, unknown>): string[];
}

export class AdapterRegistry {
  readonly #adapters = new Map<Protocol, ProviderAdapter>();
  constructor(adapters: ProviderAdapter[]) { for (const adapter of adapters) this.#adapters.set(adapter.protocol, adapter); }
  get(protocol: Protocol): ProviderAdapter {
    const adapter = this.#adapters.get(protocol);
    if (!adapter) throw new Error(`No adapter for protocol: ${protocol}`);
    return adapter;
  }
}
