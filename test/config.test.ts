import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";

const baseConfig = {
  providers: { mtel: { baseUrl: "https://catalog.example", discoverModels: true, protocols: { anthropic: { path: "/v1/messages" } } } },
  models: { "claude-static": { provider: "mtel", providerProtocol: "anthropic", upstreamModel: "claude-static", contextLimit: 123, capabilities: { tools: true, vision: true, reasoning: true, streaming: true } } },
  defaultModel: "claude-static"
};

test("startup discovery adds catalog models and preserves static overrides", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-config-"));
  const path = join(directory, "gateway.config.json");
  await writeFile(path, JSON.stringify(baseConfig));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    assert.equal(String(input), "https://catalog.example/models");
    return new Response(JSON.stringify({
      anthropic: ["claude-static", "claude-new", "claude-haiku-4-5", "claude-haiku-4-5-20251001"], openai: ["gpt-new"],
      metadata: { anthropic: { "claude-new": { attachment: false, limit: { context: 200000, output: 8192 } } } }
    }));
  };
  try {
    const config = await loadConfig(path);
    assert.deepEqual(config.models.map((model) => model.id).sort(), ["claude-haiku-4-5", "claude-new", "claude-static", "gpt-new"]);
    assert.equal(config.models.find((model) => model.id === "claude-static")?.contextLimit, 123);
    assert.equal(config.models.find((model) => model.id === "claude-new")?.contextLimit, 200000);
    assert.equal(config.models.find((model) => model.id === "claude-new")?.capabilities.vision, false);
  } finally { globalThis.fetch = originalFetch; await rm(directory, { recursive: true }); }
});

test("catalog refresh replaces discovered models and retains the last good result on failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-config-"));
  const path = join(directory, "gateway.config.json");
  await writeFile(path, JSON.stringify(baseConfig));
  const originalFetch = globalThis.fetch; const originalWarn = console.warn;
  let response: string[] | Error = ["claude-first"];
  globalThis.fetch = async () => {
    if (response instanceof Error) throw response;
    return new Response(JSON.stringify({ anthropic: response }));
  };
  console.warn = () => {};
  try {
    const config = await loadConfig(path);
    assert.equal(config.models.some((model) => model.id === "claude-first"), true);
    response = ["claude-second"];
    const refreshed = await config.refreshModels();
    assert.equal(refreshed.some((model) => model.id === "claude-first"), false);
    assert.equal(refreshed.some((model) => model.id === "claude-second"), true);
    assert.equal(config.models.some((model) => model.id === "claude-second"), true);
    response = new Error("offline");
    assert.equal((await config.refreshModels()).some((model) => model.id === "claude-second"), true);
  } finally { globalThis.fetch = originalFetch; console.warn = originalWarn; await rm(directory, { recursive: true }); }
});

test("catalog failure falls back to static models", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-config-"));
  const path = join(directory, "gateway.config.json");
  await writeFile(path, JSON.stringify(baseConfig));
  const originalFetch = globalThis.fetch; const originalWarn = console.warn;
  globalThis.fetch = async () => { throw new Error("offline"); };
  console.warn = () => {};
  try {
    const config = await loadConfig(path);
    assert.deepEqual(config.models.map((model) => model.id), ["claude-static"]);
  } finally { globalThis.fetch = originalFetch; console.warn = originalWarn; await rm(directory, { recursive: true }); }
});
