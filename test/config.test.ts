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

test("embedded ChatGPT provider gets its address from the backend and lists OpenAI-style catalog models", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-config-"));
  const path = join(directory, "gateway.config.json");
  await writeFile(path, JSON.stringify({ ...baseConfig, providers: { ...baseConfig.providers, chatgpt: { embedded: "chatgpt", baseUrl: "https://ignored.example" } } }));
  const originalFetch = globalThis.fetch; const originalWarn = console.warn;
  const urls: string[] = []; let signedIn = false; const warnings: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input); urls.push(url);
    if (url.startsWith("https://catalog.example")) return new Response(JSON.stringify({ anthropic: ["claude-static"] }));
    if (!signedIn) return new Response(JSON.stringify({ error: { type: "authentication_error" } }), { status: 401 });
    return new Response(JSON.stringify({ object: "list", data: [
      { id: "gpt-6-astra", visibility: "list", supported_in_api: true, context_window: 272000, input_modalities: ["text", "image"], supported_reasoning_levels: [{ effort: "low" }] },
      { id: "gpt-hidden", visibility: "hide", supported_in_api: true },
      { id: "gpt-no-api", visibility: "list", supported_in_api: false },
      { id: "gpt-text", visibility: "list", input_modalities: ["text"], supported_reasoning_levels: [] }
    ] }));
  };
  try {
    let started = 0;
    const config = await loadConfig(path, { chatgpt: { baseUrl: "https://override.example", apiKey: "k" } }, (line) => { warnings.push(line); },
      { chatgpt: async () => { started += 1; return "http://127.0.0.1:45678"; } });
    assert.equal(started, 1);
    const provider = config.providers.find((candidate) => candidate.id === "chatgpt")!;
    assert.equal(provider.baseUrl, "http://127.0.0.1:45678"); assert.equal(provider.apiKey, undefined);
    assert.equal(provider.protocols?.openai?.auth, "none");
    assert.ok(urls.includes("http://127.0.0.1:45678/v1/models"));
    assert.deepEqual(config.models.map((model) => model.id), ["claude-static"]);
    assert.equal(warnings.filter((line) => line.includes("not signed in to ChatGPT")).length, 1);
    await config.refreshModels();
    assert.equal(warnings.filter((line) => line.includes("not signed in to ChatGPT")).length, 1, "an unchanged failure is reported once");

    signedIn = true;
    const models = await config.refreshModels();
    const astra = models.find((model) => model.id === "codex-gpt-6-astra")!;
    assert.deepEqual(models.filter((model) => model.provider === "chatgpt").map((model) => model.id).sort(), ["codex-gpt-6-astra", "codex-gpt-text"]);
    assert.equal(astra.upstreamModel, "gpt-6-astra"); assert.equal(astra.providerProtocol, "openai"); assert.equal(astra.contextLimit, 272000);
    assert.equal(astra.capabilities.vision, true);
    assert.deepEqual((astra.providerOptions as { openai: Record<string, unknown> }).openai.max_completion_tokens, null);
    const text = models.find((model) => model.id === "codex-gpt-text")!;
    assert.equal(text.capabilities.vision, false); assert.equal(text.capabilities.reasoning, false);
    assert.throws(() => config.updateProvider("chatgpt", { apiKey: "x" }), /no editable settings/);
  } finally { globalThis.fetch = originalFetch; console.warn = originalWarn; await rm(directory, { recursive: true }); }
});

test("an embedded provider without its backend, or an unknown backend, is a startup error", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-config-"));
  const path = join(directory, "gateway.config.json");
  const originalFetch = globalThis.fetch; globalThis.fetch = async () => new Response(JSON.stringify({ anthropic: [] }));
  try {
    await writeFile(path, JSON.stringify({ ...baseConfig, providers: { ...baseConfig.providers, chatgpt: { embedded: "chatgpt" } } }));
    await assert.rejects(loadConfig(path, {}, () => {}), /embedded ChatGPT backend/);
    await writeFile(path, JSON.stringify({ ...baseConfig, providers: { ...baseConfig.providers, other: { embedded: "other" } } }));
    await assert.rejects(loadConfig(path, {}, () => {}), /unknown embedded backend/);
  } finally { globalThis.fetch = originalFetch; await rm(directory, { recursive: true }); }
});
