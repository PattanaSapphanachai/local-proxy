import type { RouteObservation } from "./types.ts";

export interface Observer { record(observation: RouteObservation): void }
export type GatewayLogLevel = "silent" | "info" | "debug";
const configuredLogLevel = (): GatewayLogLevel => {
  const level = process.env.GATEWAY_LOG_LEVEL;
  return level === "silent" || level === "debug" ? level : "info";
};

export function formatObservation(observation: RouteObservation, level: "info" | "debug" = "info"): string {
  if (level === "debug") return JSON.stringify({ event: "gateway_request", ...observation });
  const { incomingModel, incomingProtocol, upstreamModel, mode, latencyMs, timeToFirstTokenMs, inputTokens, outputTokens, toolCalls, error } = observation;
  return JSON.stringify({ event: "request", route: `${incomingModel ?? incomingProtocol}→${upstreamModel}`, mode,
    ...(latencyMs === undefined ? {} : { ms: Math.round(latencyMs) }),
    ...(timeToFirstTokenMs === undefined ? {} : { ttftMs: Math.round(timeToFirstTokenMs) }),
    ...(inputTokens === undefined && outputTokens === undefined ? {} : { tokens: `${inputTokens ?? 0}/${outputTokens ?? 0}` }),
    ...(toolCalls ? { tools: toolCalls } : {}), ...(error ? { error } : {}) });
}

// In-memory ring of recent log lines for the control UI (GET /logs, GET /logs/stream).
// Callers log hints (last four key characters), never secrets.
export type LogLevel = "info" | "warn" | "error";
export interface LogLine { id: number; at: string; level: LogLevel; text: string }
export type LogListener = (line: LogLine) => void;

export class LogBuffer {
  #lines: LogLine[] = []; #next = 1; readonly #listeners = new Set<LogListener>();
  constructor(private capacity = 500) {}
  push(level: LogLevel, text: string): LogLine {
    const line: LogLine = { id: this.#next++, at: new Date().toISOString(), level, text };
    this.#lines.push(line);
    if (this.#lines.length > this.capacity) this.#lines.splice(0, this.#lines.length - this.capacity);
    for (const listener of this.#listeners) { try { listener(line); } catch { /* a broken subscriber must not break logging */ } }
    return line;
  }
  since(id = 0): LogLine[] { return this.#lines.filter((line) => line.id > id); }
  subscribe(listener: LogListener): () => void { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; }
}

export class JsonConsoleObserver implements Observer {
  constructor(private level: GatewayLogLevel = configuredLogLevel(), private buffer?: LogBuffer) {}
  record(observation: RouteObservation): void {
    const line = formatObservation(observation, this.level === "debug" ? "debug" : "info");
    this.buffer?.push(observation.error ? "error" : "info", line);
    if (this.level !== "silent") console.log(line);
  }
}
export class NoopObserver implements Observer { record(_observation: RouteObservation): void {} }
