import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startGateway } from "../src/app.ts";
import { claudeDesktopStatus, CREDENTIAL_TOKEN, defaultEnvironment, PROFILE_NAME, setDeploymentMode, setupClaudeDesktop, type ClaudeDesktopEnvironment } from "../src/claude-desktop.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (response: Response): Promise<any> => response.json();
const readJson = async (path: string) => JSON.parse(await readFile(path, "utf8"));

// Fake process control: ps lists the app binary (plus a CLI helper that must not count) while `running`, osascript quits, open relaunches.
const PS_IDLE = "  123 /usr/bin/something\n  456 /Users/me/Library/Application Support/Claude-3p/claude-code/2.1.321/x/claude.app/Contents/MacOS/claude\n";
const PS_RUNNING = `${PS_IDLE}  789 /Applications/Claude.app/Contents/MacOS/Claude\n`;
function fakeMac(running = false) {
  const state = { running, calls: [] as string[][] };
  const run: ClaudeDesktopEnvironment["run"] = async (command, args) => {
    state.calls.push([command, ...args]);
    if (command === "ps") return { code: 0, stdout: state.running ? PS_RUNNING : PS_IDLE };
    if (command === "osascript") { state.running = false; return { code: 0, stdout: "" }; }
    if (command === "open") { state.running = true; return { code: 0, stdout: "" }; }
    return { code: 1, stdout: "" };
  };
  return { state, run };
}
async function fixture(running = false) {
  const dir = await mkdtemp(join(tmpdir(), "claude-desktop-"));
  const appPath = join(dir, "Claude.app"); await mkdir(appPath);
  const mac = fakeMac(running);
  const env = defaultEnvironment({ platform: "darwin", dataDir: join(dir, "Claude-3p"), helperPath: join(dir, "Local Proxy", "claude-desktop-credential"), appPaths: [appPath], run: mac.run, displayName: "Test Co" });
  return { dir, env, mac };
}

test("setup writes the helper, the applied profile, and 3p mode, preserving unrelated keys", async () => {
  const { dir, env, mac } = await fixture(true);
  try {
    await mkdir(join(env.dataDir, "configLibrary"), { recursive: true });
    await writeFile(join(env.dataDir, "claude_desktop_config.json"), JSON.stringify({ deploymentMode: "1p", preferences: { keep: true } }));
    await writeFile(join(env.dataDir, "configLibrary", "_meta.json"), JSON.stringify({ appliedId: "other", entries: [{ id: "other", name: "Company" }] }));

    const before = await claudeDesktopStatus("http://localhost:8787", env);
    assert.equal(before.installed, true); assert.equal(before.running, true); assert.equal(before.configured, false);
    assert.ok(before.issues.some((issue) => issue.includes("not in third-party")));

    const result = await setupClaudeDesktop("http://localhost:8787", ["claude-test", "gpt-5.6-sol"], env);
    assert.equal(result.configured, true, result.issues.join("; ")); assert.equal(result.wasRunning, true); assert.equal(result.relaunched, true); assert.equal(result.running, true);
    assert.deepEqual(mac.state.calls.filter(([command]) => command !== "ps"), [["osascript", "-e", 'quit app id "com.anthropic.claudefordesktop"'], ["open", "-b", "com.anthropic.claudefordesktop"]]);

    assert.equal((await stat(env.helperPath)).mode & 0o777, 0o700);
    assert.match(await readFile(env.helperPath, "utf8"), new RegExp(`^#!/bin/sh[\\s\\S]*printf '%s' '${CREDENTIAL_TOKEN}'\\n$`));
    const meta = await readJson(join(env.dataDir, "configLibrary", "_meta.json"));
    assert.equal(meta.entries.length, 2); assert.equal(meta.entries[0].name, "Company");
    const entry = meta.entries.find((candidate: { name: string }) => candidate.name === PROFILE_NAME);
    assert.equal(meta.appliedId, entry.id);
    const profile = await readJson(join(env.dataDir, "configLibrary", `${entry.id}.json`));
    assert.equal(profile.inferenceProvider, "gateway"); assert.equal(profile.inferenceGatewayBaseUrl, "http://localhost:8787");
    assert.equal(profile.inferenceGatewayAuthScheme, "x-api-key"); assert.equal(profile.inferenceCredentialKind, "helper-script");
    assert.equal(profile.inferenceCredentialHelper, env.helperPath); assert.equal(profile.modelDiscoveryEnabled, true);
    assert.deepEqual(profile.inferenceModels, [{ name: "claude-test" }]); assert.equal(profile.deploymentDisplayName, "Test Co");
    assert.equal(profile.inferenceGatewayAutoModeServerChecks, false); assert.equal(profile.autoModeClassifierModel, undefined);
    assert.equal((await stat(join(env.dataDir, "configLibrary", `${entry.id}.json`))).mode & 0o777, 0o600);
    assert.deepEqual(await readJson(join(env.dataDir, "claude_desktop_config.json")), { deploymentMode: "3p", preferences: { keep: true } });

    // Running setup again keeps the same entry id and does not add a duplicate.
    await writeFile(join(env.dataDir, "configLibrary", `${entry.id}.json`), JSON.stringify({ ...profile, customKept: 1 }));
    const again = await setupClaudeDesktop("http://localhost:8787", ["claude-test"], env, { relaunch: false });
    assert.equal(again.configured, true);
    const metaAgain = await readJson(join(env.dataDir, "configLibrary", "_meta.json"));
    assert.equal(metaAgain.entries.length, 2); assert.equal(metaAgain.appliedId, entry.id);
    assert.equal((await readJson(join(env.dataDir, "configLibrary", `${entry.id}.json`))).customKept, 1);
  } finally { await rm(dir, { recursive: true }); }
});

test("status reports a missing app, a stale profile, and an unsupported platform", async () => {
  const { dir, env } = await fixture();
  try {
    const missingApp = await claudeDesktopStatus("http://localhost:8787", { ...env, appPaths: [join(dir, "nope.app")] });
    assert.equal(missingApp.installed, false); assert.equal(missingApp.configured, false);
    await setupClaudeDesktop("http://localhost:8787", ["claude-test"], env, { relaunch: false });
    const stale = await claudeDesktopStatus("http://localhost:9999", env);
    assert.equal(stale.configured, false); assert.ok(stale.issues.some((issue) => issue.includes("http://localhost:8787 instead of http://localhost:9999")));
    // A profile written before server-side checks were turned off is reported, and setup fixes it.
    const entryId = (await readJson(join(env.dataDir, "configLibrary", "_meta.json"))).entries[0].id;
    const profilePath = join(env.dataDir, "configLibrary", `${entryId}.json`);
    const { inferenceGatewayAutoModeServerChecks: _checks, ...legacy } = await readJson(profilePath);
    await writeFile(profilePath, JSON.stringify(legacy));
    const legacyStatus = await claudeDesktopStatus("http://localhost:8787", env);
    assert.equal(legacyStatus.profileReady, false); assert.ok(legacyStatus.issues.some((issue) => issue.includes("server-side Auto mode checks")));
    await setupClaudeDesktop("http://localhost:8787", ["claude-test", "claude-sonnet-5"], env, { relaunch: false });
    const fixed = await readJson(profilePath);
    assert.equal(fixed.inferenceGatewayAutoModeServerChecks, false); assert.equal(fixed.autoModeClassifierModel, "claude-sonnet-5");
    assert.equal((await claudeDesktopStatus("http://localhost:8787", env)).profileReady, true);
    const other = await claudeDesktopStatus("http://localhost:8787", { ...env, platform: "linux" });
    assert.equal(other.supported, false);
    await assert.rejects(setupClaudeDesktop("http://localhost:8787", [], { ...env, platform: "linux" }), /only available on macOS/);
    await assert.rejects(setupClaudeDesktop("http://localhost:8787", [], { ...env, helperPath: '/bad "path' }), /not accepted/);
  } finally { await rm(dir, { recursive: true }); }
});

test("switching deployment mode rewrites only deploymentMode, keeps the profile, and relaunches", async () => {
  const { dir, env, mac } = await fixture();
  try {
    await setupClaudeDesktop("http://localhost:8787", ["claude-test"], env, { relaunch: false });
    const configPath = join(env.dataDir, "claude_desktop_config.json");
    await writeFile(configPath, JSON.stringify({ deploymentMode: "3p", preferences: { keep: true } }));
    mac.state.running = true; mac.state.calls.length = 0;

    const to1p = await setDeploymentMode("http://localhost:8787", "1p", env);
    assert.equal(to1p.deploymentMode, "1p"); assert.equal(to1p.configured, false); assert.equal(to1p.profileReady, true);
    assert.equal(to1p.wasRunning, true); assert.equal(to1p.relaunched, true); assert.equal(to1p.running, true);
    assert.deepEqual(to1p.issues, ["Claude Desktop is not in third-party (3p) mode."]);
    assert.deepEqual(mac.state.calls.filter(([command]) => command !== "ps"), [["osascript", "-e", 'quit app id "com.anthropic.claudefordesktop"'], ["open", "-b", "com.anthropic.claudefordesktop"]]);
    assert.deepEqual(await readJson(configPath), { deploymentMode: "1p", preferences: { keep: true } });
    assert.equal((await readJson(join(env.dataDir, "configLibrary", "_meta.json"))).entries.length, 1);

    const back = await setDeploymentMode("http://localhost:8787", "3p", env, { relaunch: false });
    assert.equal(back.deploymentMode, "3p"); assert.equal(back.configured, true); assert.equal(back.relaunched, false);
    assert.deepEqual(await readJson(configPath), { deploymentMode: "3p", preferences: { keep: true } });
    await assert.rejects(setDeploymentMode("http://localhost:8787", "1p", { ...env, platform: "linux" }), /only available on macOS/);
  } finally { await rm(dir, { recursive: true }); }
});

test("gateway exposes Claude Desktop status and setup endpoints", async () => {
  const { dir, env, mac } = await fixture();
  const capabilities = { tools: true, vision: true, reasoning: true, streaming: true };
  await writeFile(join(dir, "gateway.config.json"), JSON.stringify({ host: "127.0.0.1", port: 0,
    providers: { mtel: { baseUrl: "https://upstream.example", protocols: { anthropic: { path: "/v1/messages", auth: "anthropic" } } } },
    models: { "claude-test": { provider: "mtel", providerProtocol: "anthropic", upstreamModel: "claude-test", capabilities } }, defaultModel: "claude-test" }));
  const gateway = await startGateway({ configPath: join(dir, "gateway.config.json"), statePath: join(dir, "state.json"), claudeDesktop: env, warn: () => {} });
  try {
    const status = await json(await fetch(`${gateway.url}/claude-desktop`));
    assert.equal(status.supported, true); assert.equal(status.installed, true); assert.equal(status.configured, false);
    assert.equal(status.gatewayUrl, `http://localhost:${gateway.port}`);
    const setup = await fetch(`${gateway.url}/claude-desktop/setup`, { method: "POST" });
    assert.equal(setup.status, 200); const result = await json(setup);
    assert.equal(result.configured, true, result.issues.join("; ")); assert.equal(result.relaunched, true);
    assert.deepEqual(mac.state.calls.at(-1), ["open", "-b", "com.anthropic.claudefordesktop"]);
    const entry = (await readJson(join(env.dataDir, "configLibrary", "_meta.json"))).entries[0];
    assert.deepEqual((await readJson(join(env.dataDir, "configLibrary", `${entry.id}.json`))).inferenceModels, [{ name: "claude-test" }]);
    assert.equal((await json(await fetch(`${gateway.url}/claude-desktop`))).configured, true);
    assert.deepEqual(await json(await fetch(`${gateway.url}/claude-desktop/open`, { method: "POST" })), { ok: true });
    const badMode = await fetch(`${gateway.url}/claude-desktop/mode`, { method: "PUT", body: JSON.stringify({ mode: "nope" }) });
    assert.equal(badMode.status, 400);
    const switched = await fetch(`${gateway.url}/claude-desktop/mode`, { method: "PUT", body: JSON.stringify({ mode: "1p" }) });
    assert.equal(switched.status, 200); const mode = await json(switched);
    assert.equal(mode.deploymentMode, "1p"); assert.equal(mode.profileReady, true); assert.equal(mode.configured, false); assert.equal(mode.relaunched, true);
    assert.equal((await json(await fetch(`${gateway.url}/claude-desktop`))).deploymentMode, "1p");
    const { lines } = await json(await fetch(`${gateway.url}/logs`));
    assert.ok(lines.some((line: { text: string }) => line.text.includes(`[claude-desktop] profile "${PROFILE_NAME}"`)));
    assert.ok(lines.some((line: { text: string }) => line.text.includes("[claude-desktop] deployment mode → 1p")));
  } finally { await gateway.close(); await rm(dir, { recursive: true }); }
});
