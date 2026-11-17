import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startGateway } from "../src/app.ts";
import { loadUserSettings } from "../src/user-settings.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (response: Response): Promise<any> => response.json();
const capabilities = { tools: true, vision: true, reasoning: true, streaming: true };
const config = {
  host: "127.0.0.1", port: 0,
  providers: { mtel: { baseUrl: "https://upstream.example", apiKeyFile: "/nonexistent/local-proxy-test/mtel-key", protocols: { anthropic: { path: "/v1/messages", auth: "anthropic" } } } },
  models: { "claude-test": { provider: "mtel", providerProtocol: "anthropic", upstreamModel: "claude-test", capabilities } },
  defaultModel: "claude-test"
};

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "gateway-app-"));
  await writeFile(join(dir, "gateway.config.json"), JSON.stringify(config));
  await mkdir(join(dir, "ui")); await writeFile(join(dir, "ui", "index.html"), "<!doctype html><title>control ui</title>");
  const warnings: string[] = [];
  const options = { configPath: join(dir, "gateway.config.json"), statePath: join(dir, "state.json"), userSettingsPath: join(dir, "user-settings.json"), uiDir: join(dir, "ui"), warn: (line: string) => { warnings.push(line); } };
  return { dir, options, warnings };
}
const quiet = () => { const original = console.warn; console.warn = () => {}; return () => { console.warn = original; }; };

test("settings endpoint stores an editable key and base URL without echoing the key", async () => {
  const { dir, options } = await fixture(); const restore = quiet();
  const gateway = await startGateway(options);
  try {
    assert.deepEqual(await json(await fetch(`${gateway.url}/health`)), { ok: true });
    let settings = await json(await fetch(`${gateway.url}/settings`));
    assert.equal(settings.persisted, true); assert.equal(settings.defaultProvider, "mtel");
    assert.deepEqual(settings.providers, [{ id: "mtel", baseUrl: "https://upstream.example", hasApiKey: false, apiKeyHint: null }]);

    const updated = await fetch(`${gateway.url}/settings`, { method: "PUT", body: JSON.stringify({ apiKey: " sk-test-1234 ", baseUrl: "https://other.example/" }) });
    assert.equal(updated.status, 200); settings = await json(updated);
    assert.deepEqual(settings.providers, [{ id: "mtel", baseUrl: "https://other.example", hasApiKey: true, apiKeyHint: "…1234" }]);
    assert.equal(JSON.stringify(settings).includes("sk-test"), false);
    assert.equal(gateway.config.providers[0].apiKey, "sk-test-1234");
    assert.deepEqual(await loadUserSettings(options.userSettingsPath), { providers: { mtel: { apiKey: "sk-test-1234", baseUrl: "https://other.example" } } });

    assert.equal((await fetch(`${gateway.url}/settings`, { method: "PUT", body: JSON.stringify({ baseUrl: "not a url" }) })).status, 400);
    assert.equal((await fetch(`${gateway.url}/settings`, { method: "PUT", body: JSON.stringify({ baseUrl: "ftp://x.example" }) })).status, 400);
    assert.equal((await fetch(`${gateway.url}/settings`, { method: "PUT", body: JSON.stringify({}) })).status, 400);
    assert.equal((await fetch(`${gateway.url}/settings`, { method: "PUT", body: JSON.stringify({ provider: "nope", apiKey: "k" }) })).status, 400);
    assert.equal(gateway.config.providers[0].baseUrl, "https://other.example");
  } finally { await gateway.close(); }

  const again = await startGateway(options);
  try {
    const settings = await json(await fetch(`${again.url}/settings`));
    assert.equal(settings.providers[0].hasApiKey, true);
    assert.equal(again.config.providers[0].apiKey, "sk-test-1234"); assert.equal(again.config.providers[0].baseUrl, "https://other.example");
    const cleared = await json(await fetch(`${again.url}/settings`, { method: "PUT", body: JSON.stringify({ apiKey: "" }) }));
    assert.equal(cleared.providers[0].hasApiKey, false); assert.equal(again.config.providers[0].apiKey, undefined);
    assert.deepEqual(await loadUserSettings(options.userSettingsPath), { providers: { mtel: { baseUrl: "https://other.example" } } });
  } finally { await again.close(); restore(); await rm(dir, { recursive: true }); }
});

test("control UI is served from uiDir and cannot escape it", async () => {
  const { dir, options } = await fixture(); const restore = quiet();
  const gateway = await startGateway(options);
  try {
    const page = await fetch(`${gateway.url}/`);
    assert.equal(page.status, 200); assert.match(page.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await page.text(), /control ui/);
    assert.equal((await fetch(`${gateway.url}/index.html`)).status, 200);
    assert.equal((await fetch(`${gateway.url}/missing.js`)).status, 404);
    assert.equal((await fetch(`${gateway.url}/%2e%2e%2fgateway.config.json`)).status, 404);
    assert.equal((await fetch(`${gateway.url}/..%2fgateway.config.json`)).status, 404);
    const status = await json(await fetch(`${gateway.url}/status`));
    assert.equal(status.url, gateway.url); assert.equal(status.routing.model, "claude-test");
  } finally { await gateway.close(); restore(); await rm(dir, { recursive: true }); }
});

test("user settings default to empty when the file does not exist", async () => {
  assert.deepEqual(await loadUserSettings("/nonexistent/local-proxy-test/user-settings.json"), { providers: {} });
});

test("logs endpoint replays buffered lines and streams new ones without secrets", async () => {
  const { dir, options } = await fixture(); const restore = quiet();
  const gateway = await startGateway(options);
  try {
    const { lines } = await json(await fetch(`${gateway.url}/logs`));
    assert.ok(lines.some((line: { text: string }) => line.text.includes(`listening on ${gateway.url}`)), "startup line is buffered");
    assert.ok(lines.some((line: { level: string; text: string }) => line.level === "warn" && line.text.includes("[config] API key file")), "config warning is buffered");
    const last = lines.at(-1).id;
    assert.deepEqual((await json(await fetch(`${gateway.url}/logs?since=${last}`))).lines, []);

    const controller = new AbortController();
    const stream = await fetch(`${gateway.url}/logs/stream?since=${last}`, { signal: controller.signal });
    assert.match(stream.headers.get("content-type") ?? "", /text\/event-stream/);
    await fetch(`${gateway.url}/routing`, { method: "PUT", body: JSON.stringify({ reasoningEffort: "high" }) });
    await fetch(`${gateway.url}/settings`, { method: "PUT", body: JSON.stringify({ apiKey: "sk-secret-7777" }) });
    const reader = stream.body!.getReader(); let text = "";
    while (!text.includes("[settings]")) { const { value, done } = await reader.read(); if (done) break; text += new TextDecoder().decode(value); }
    await reader.cancel().catch(() => {}); controller.abort();
    assert.match(text, /^id: \d+\ndata: \{/m);
    assert.match(text, /\[routing\] now claude-test · force-model · effort high/);
    assert.match(text, /\[settings\] mtel → https:\/\/upstream\.example \(key …7777\)/);
    assert.equal(text.includes("sk-secret"), false);

    const after = await json(await fetch(`${gateway.url}/logs?since=${last}`));
    assert.equal(after.lines.length, 2);
    assert.equal(JSON.stringify(after).includes("sk-secret"), false);
    assert.equal(gateway.logs.since(last).length, 2);
  } finally { await gateway.close(); restore(); await rm(dir, { recursive: true }); }
});

test("log buffer capacity is configurable through startGateway", async () => {
  const { dir, options } = await fixture(); const restore = quiet();
  const gateway = await startGateway({ ...options, logCapacity: 2 });
  try {
    for (const effort of ["low", "medium", "high"]) await fetch(`${gateway.url}/routing`, { method: "PUT", body: JSON.stringify({ reasoningEffort: effort }) });
    const { lines } = await json(await fetch(`${gateway.url}/logs`));
    assert.deepEqual(lines.map((line: { text: string }) => line.text.replace(/.*effort /, "")), ["medium", "high"]);
  } finally { await gateway.close(); restore(); await rm(dir, { recursive: true }); }
});

test("embedded ChatGPT backend starts with the gateway, reports sign-in status, and is hidden from connection settings", async () => {
  const { dir, options } = await fixture(); const restore = quiet();
  await writeFile(options.configPath, JSON.stringify({ ...config, providers: { ...config.providers, chatgpt: { embedded: "chatgpt" } } }));
  const codexHome = join(dir, "codex");
  const gateway = await startGateway({ ...options, chatgpt: { authPath: join(codexHome, "auth.json"), codexConfig: { codexHome, configPath: join(codexHome, "config.toml") } } });
  try {
    const status = await json(await fetch(`${gateway.url}/chatgpt`));
    assert.deepEqual(status, { enabled: true, provider: "chatgpt", status: "unauthenticated", modelCount: 0 });
    const backend = gateway.config.providers.find((provider) => provider.id === "chatgpt")!;
    assert.match(backend.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal((await fetch(`${backend.baseUrl}/v1/models`)).status, 401);
    const settings = await json(await fetch(`${gateway.url}/settings`));
    assert.deepEqual(settings.providers.map((provider: { id: string }) => provider.id), ["mtel"]);
    assert.equal((await fetch(`${gateway.url}/settings`, { method: "PUT", body: JSON.stringify({ provider: "chatgpt", apiKey: "k" }) })).status, 400);
    assert.equal((await fetch(`${gateway.url}/chatgpt/login/missing`)).status, 404);
    const { lines } = await json(await fetch(`${gateway.url}/logs`));
    assert.ok(lines.some((line: { text: string }) => line.text.includes("[chatgpt] embedded backend on")));
  } finally { await gateway.close(); restore(); await rm(dir, { recursive: true }); }
  await assert.rejects(fetch(gatewayBackendUrl(gateway)), "backend is closed with the gateway");
});

test("ChatGPT status is disabled when no embedded provider is configured", async () => {
  const { dir, options } = await fixture(); const restore = quiet();
  const gateway = await startGateway(options);
  try {
    assert.deepEqual(await json(await fetch(`${gateway.url}/chatgpt`)), { enabled: false });
    assert.equal((await fetch(`${gateway.url}/chatgpt/login`, { method: "POST" })).status, 404);
  } finally { await gateway.close(); restore(); await rm(dir, { recursive: true }); }
});

const gatewayBackendUrl = (gateway: { config: { providers: Array<{ id: string; baseUrl: string }> } }) => `${gateway.config.providers.find((provider) => provider.id === "chatgpt")!.baseUrl}/v1/models`;
