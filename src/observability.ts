import type { RouteObservation } from "./types.ts";

export interface Observer { record(observation: RouteObservation): void }
export type GatewayLogLevel = "silent" | "info" | "debug";
const configuredLogLevel = (): GatewayLogLevel => {
  const level = process.env.GATEWAY_LOG_LEVEL;
  return level === "silent" || level === "debug" ? level : "info";
};

export class JsonConsoleObserver implements Observer {
  constructor(private level: GatewayLogLevel = configuredLogLevel()) {}
  record(observation: RouteObservation): void {
    if (this.level === "silent") return;
    if (this.level === "debug") return console.log(JSON.stringify({ event: "gateway_request", ...observation }));
    const { incomingModel, incomingProtocol, upstreamModel, mode, latencyMs, timeToFirstTokenMs, inputTokens, outputTokens, toolCalls, error } = observation;
    console.log(JSON.stringify({ event: "request", route: `${incomingModel ?? incomingProtocol}→${upstreamModel}`, mode,
      ...(latencyMs === undefined ? {} : { ms: Math.round(latencyMs) }),
      ...(timeToFirstTokenMs === undefined ? {} : { ttftMs: Math.round(timeToFirstTokenMs) }),
      ...(inputTokens === undefined && outputTokens === undefined ? {} : { tokens: `${inputTokens ?? 0}/${outputTokens ?? 0}` }),
      ...(toolCalls ? { tools: toolCalls } : {}), ...(error ? { error } : {}) }));
  }
}
export class NoopObserver implements Observer { record(_observation: RouteObservation): void {} }
