import test from "node:test";
import assert from "node:assert/strict";
import { JsonConsoleObserver } from "../src/observability.ts";
import type { RouteObservation } from "../src/types.ts";

const observation: RouteObservation = {
  incomingProtocol: "anthropic", incomingModel: "claude-opus-5-5", selectedModel: "gpt-5.6-sol",
  upstreamProvider: "mtel", upstreamModel: "gpt-5.6-sol", mode: "converted", latencyMs: 17658.845709,
  timeToFirstTokenMs: 16305.871959, inputTokens: 0, outputTokens: 327, toolCalls: 1
};

function capture(level: "silent" | "info" | "debug"): string[] {
  const lines: string[] = []; const original = console.log;
  console.log = (line) => lines.push(String(line));
  try { new JsonConsoleObserver(level).record(observation); } finally { console.log = original; }
  return lines;
}

test("info request logs are compact and rounded", () => {
  assert.deepEqual(JSON.parse(capture("info")[0]), {
    event: "request", route: "claude-opus-5-5→gpt-5.6-sol", mode: "converted",
    ms: 17659, ttftMs: 16306, tokens: "0/327", tools: 1
  });
});

test("debug preserves the full routing observation", () => {
  assert.deepEqual(JSON.parse(capture("debug")[0]), { event: "gateway_request", ...observation });
});

test("silent disables request logs", () => assert.deepEqual(capture("silent"), []));
