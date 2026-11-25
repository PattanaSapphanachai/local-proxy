import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { GatewayError } from "./errors.ts";

// Claude Desktop's third-party ("3p") provider mode keeps its state in a separate data folder
// (~/Library/Application Support/Claude-3p). This module writes the profile that points it at the gateway:
//   configLibrary/<uuid>.json   the profile (gateway URL, auth scheme, credential helper, model list)
//   configLibrary/_meta.json    { appliedId, entries: [{ id, name }] }
//   claude_desktop_config.json  { deploymentMode: "3p" | "1p", ...untouched keys }
// Whichever mode it is in, Claude Desktop reads deploymentMode from that file (always the -3p folder) at launch and only
// then redirects its data folder to Claude-3p; "1p" keeps it on Claude.ai. Its own mode switch is that write plus a
// relaunch, which setDeploymentMode mirrors. The layout was read from Claude 5.1231.2 and 5.11492.2 and is not a
// documented interface, so unknown keys are preserved and files are only written while Claude Desktop is closed
// (it reads the profile at launch and rewrites the config on quit).

export const CLAUDE_BUNDLE_ID = "com.anthropic.claudefordesktop";
export const CLAUDE_DOWNLOAD_URL = "https://claude.ai/download";
export const PROFILE_NAME = "Local Proxy";
// Claude Desktop insists on a non-empty credential, but the gateway injects the real Polycon key itself.
export const CREDENTIAL_TOKEN = "local-proxy";

/** Claude Desktop's persisted deployment mode: "3p" runs against a configured third-party provider (this gateway), "1p" against Claude.ai. */
export type DeploymentMode = "1p" | "3p";
export type RunCommand = (command: string, args: string[]) => Promise<{ code: number; stdout: string }>;
export interface ClaudeDesktopEnvironment {
  platform: NodeJS.Platform;
  /** Claude Desktop's 3p data folder. */
  dataDir: string;
  /** Executable Claude Desktop runs to obtain the credential. Must be an absolute path without quotes or percent signs. */
  helperPath: string;
  /** Candidate locations of Claude.app. */
  appPaths: string[];
  run: RunCommand;
  /** Shown in Claude Desktop as the deployment name. */
  displayName: string;
}
export interface ClaudeDesktopStatus {
  supported: boolean; installed: boolean; appPath: string | null; running: boolean; configured: boolean;
  profileName: string; gatewayUrl: string; dataDir: string; helperPath: string; downloadUrl: string; issues: string[];
  /** Mode persisted in claude_desktop_config.json, or null when it has never been set. */
  deploymentMode: DeploymentMode | null;
  /** The "Local Proxy" profile and credential helper are in place, whatever the current mode. */
  profileReady: boolean;
}
export interface ClaudeDesktopSetupResult extends ClaudeDesktopStatus { wasRunning: boolean; relaunched: boolean }

interface LibraryEntry { id: string; name: string; [key: string]: unknown }
type JsonObject = Record<string, unknown>;

const exec = promisify(execFile);
const defaultRun: RunCommand = async (command, args) => {
  try { const { stdout } = await exec(command, args, { timeout: 15_000 }); return { code: 0, stdout }; }
  catch (error) { const failure = error as { code?: number | string; stdout?: string }; return { code: typeof failure.code === "number" ? failure.code : 1, stdout: failure.stdout ?? "" }; }
};

export function defaultEnvironment(overrides: Partial<ClaudeDesktopEnvironment> = {}): ClaudeDesktopEnvironment {
  const home = homedir(); const support = join(home, "Library", "Application Support");
  return {
    platform: process.platform, dataDir: join(support, "Claude-3p"), helperPath: join(support, "Local Proxy", "claude-desktop-credential"),
    appPaths: ["/Applications/Claude.app", join(home, "Applications", "Claude.app")], run: defaultRun, displayName: "MTEL Polycon", ...overrides
  };
}

// Auto mode's safety check. The gateway can route a session to GPT, which cannot return the provider's server-side
// verdict (safeguard_results), so a server-side check would stall every GPT session on Claude Desktop's
// "switched to its built-in safety check" card. With it off, Claude Code's built-in classifier always runs; its
// requests go through the gateway like any other and follow the selected route (GPT when GPT is selected).
export const AUTO_MODE_SERVER_CHECKS_KEY = "inferenceGatewayAutoModeServerChecks";
export const AUTO_MODE_CLASSIFIER_MODEL = "claude-sonnet-5";

export function buildProfile(gatewayUrl: string, helperPath: string, modelIds: string[], displayName: string): JsonObject {
  return {
    [AUTO_MODE_SERVER_CHECKS_KEY]: false,
    // Pinned to a plain ID the gateway lists, so the classifier never asks for a [1m] variant. The gateway still decides the real model.
    ...(modelIds.includes(AUTO_MODE_CLASSIFIER_MODEL) ? { autoModeClassifierModel: AUTO_MODE_CLASSIFIER_MODEL } : {}),
    inferenceProvider: "gateway",
    inferenceGatewayBaseUrl: gatewayUrl,
    inferenceGatewayAuthScheme: "x-api-key",
    inferenceCredentialKind: "helper-script",
    inferenceCredentialHelper: helperPath,
    inferenceCredentialHelperTimeoutSec: 10,
    modelDiscoveryEnabled: true,
    // Claude Desktop only accepts Anthropic model names from a gateway; the list seeds its picker if discovery fails.
    inferenceModels: modelIds.filter((id) => /claude/i.test(id)).map((name) => ({ name })),
    autoModeEnabled: true,
    toolSearchEnabled: true,
    allowedPluginMarketplaces: [{ source: "git", url: "https://github.com/anthropics/claude-plugins-official" }],
    deploymentDisplayName: displayName
  };
}

const paths = (env: ClaudeDesktopEnvironment) => ({
  config: join(env.dataDir, "claude_desktop_config.json"), library: join(env.dataDir, "configLibrary"),
  meta: join(env.dataDir, "configLibrary", "_meta.json"), entry: (id: string) => join(env.dataDir, "configLibrary", `${id}.json`)
});
const exists = (path: string) => access(path).then(() => true, () => false);
async function firstExisting(candidates: string[]): Promise<string | null> { for (const path of candidates) if (await exists(path)) return path; return null; }
async function readJson(path: string): Promise<JsonObject> {
  try { const parsed = JSON.parse(await readFile(path, "utf8")) as unknown; return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as JsonObject : {}; }
  catch (error) { if ((error as { code?: string }).code === "ENOENT") return {}; throw error; }
}
async function writeAtomic(path: string, content: string, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, content, { mode }); await rename(temporary, path); }
  catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}
const writeJson = (path: string, value: unknown) => writeAtomic(path, `${JSON.stringify(value, null, 2)}\n`, 0o600);
const parseMode = (value: unknown): DeploymentMode | null => value === "3p" || value === "1p" ? value : null;
const isEntry = (value: unknown): value is LibraryEntry => Boolean(value) && typeof value === "object" && typeof (value as LibraryEntry).id === "string" && typeof (value as LibraryEntry).name === "string";

// pgrep cannot see the main Claude Desktop process on macOS, so list executables with ps and match the app bundle binary only:
// the lowercase claude-code CLI it spawns lives under ".../claude.app/Contents/MacOS/claude" and must not count.
export const CLAUDE_PROCESS_PATTERN = /\/Claude\.app\/Contents\/MacOS\/Claude$/m;
async function isRunning(env: ClaudeDesktopEnvironment): Promise<boolean> {
  const { code, stdout } = await env.run("ps", ["-axo", "pid=,comm="]);
  return code === 0 && CLAUDE_PROCESS_PATTERN.test(stdout);
}
async function quitClaude(env: ClaudeDesktopEnvironment): Promise<void> {
  await env.run("osascript", ["-e", `quit app id "${CLAUDE_BUNDLE_ID}"`]);
  for (let attempt = 0; attempt < 40 && await isRunning(env); attempt++) await new Promise((resolve) => setTimeout(resolve, 250));
  if (await isRunning(env)) throw new GatewayError("INVALID_REQUEST", "Claude Desktop did not quit. Quit it manually and try again.", 409);
}
export async function openClaudeDesktop(env: ClaudeDesktopEnvironment): Promise<void> {
  if (env.platform !== "darwin") throw new GatewayError("INVALID_REQUEST", "Claude Desktop setup is only available on macOS", 400);
  const { code } = await env.run("open", ["-b", CLAUDE_BUNDLE_ID]);
  if (code !== 0) throw new GatewayError("INVALID_REQUEST", `Claude Desktop could not be opened. Install it from ${CLAUDE_DOWNLOAD_URL}.`, 404);
}

export async function claudeDesktopStatus(gatewayUrl: string, env: ClaudeDesktopEnvironment): Promise<ClaudeDesktopStatus> {
  const base = { profileName: PROFILE_NAME, gatewayUrl, dataDir: env.dataDir, helperPath: env.helperPath, downloadUrl: CLAUDE_DOWNLOAD_URL };
  if (env.platform !== "darwin") return { ...base, supported: false, installed: false, appPath: null, running: false, configured: false, deploymentMode: null, profileReady: false, issues: ["Claude Desktop setup is only available on macOS."] };
  const [appPath, running, config, meta, helperPresent] = await Promise.all([firstExisting(env.appPaths), isRunning(env), readJson(paths(env).config), readJson(paths(env).meta), exists(env.helperPath)]);
  const deploymentMode = parseMode(config.deploymentMode);
  const issues: string[] = [];
  const entries = Array.isArray(meta.entries) ? meta.entries.filter(isEntry) : [];
  const entry = entries.find((candidate) => candidate.name === PROFILE_NAME);
  if (!entry) issues.push(`No "${PROFILE_NAME}" profile exists in Claude Desktop.`);
  else {
    if (meta.appliedId !== entry.id) issues.push(`The "${PROFILE_NAME}" profile exists but another profile is applied.`);
    const profile = await readJson(paths(env).entry(entry.id));
    if (profile.inferenceGatewayBaseUrl !== gatewayUrl) issues.push(`The profile points at ${String(profile.inferenceGatewayBaseUrl ?? "nothing")} instead of ${gatewayUrl}.`);
    if (profile.inferenceCredentialHelper !== env.helperPath) issues.push("The profile uses a different credential helper.");
    if (profile[AUTO_MODE_SERVER_CHECKS_KEY] !== false) issues.push("The profile still asks the gateway for server-side Auto mode checks, which stall GPT sessions. Run setup again.");
  }
  if (!helperPresent) issues.push("The credential helper has not been written yet.");
  const profileReady = issues.length === 0;
  if (deploymentMode !== "3p") issues.unshift("Claude Desktop is not in third-party (3p) mode.");
  return { ...base, supported: true, installed: appPath !== null, appPath, running, configured: profileReady && deploymentMode === "3p", deploymentMode, profileReady, issues };
}

export async function setupClaudeDesktop(gatewayUrl: string, modelIds: string[], env: ClaudeDesktopEnvironment, options: { relaunch?: boolean } = {}): Promise<ClaudeDesktopSetupResult> {
  if (env.platform !== "darwin") throw new GatewayError("INVALID_REQUEST", "Claude Desktop setup is only available on macOS", 400);
  if (!/^[^"%\x00-\x1f]+$/.test(env.helperPath) || !env.helperPath.startsWith("/") || /[. ]$/.test(env.helperPath)) throw new GatewayError("INVALID_REQUEST", `Credential helper path is not accepted by Claude Desktop: ${env.helperPath}`, 500);
  const wasRunning = await isRunning(env);
  if (wasRunning) await quitClaude(env); // Claude Desktop reads the profile at launch and rewrites its config on quit.

  await writeAtomic(env.helperPath, `#!/bin/sh\n# Written by Local Proxy. Claude Desktop runs this to obtain a credential for the local gateway;\n# the gateway adds the real MTEL Polycon key itself, so this value only has to be non-empty.\nprintf '%s' '${CREDENTIAL_TOKEN}'\n`, 0o700);
  const { config: configPath, library, meta: metaPath, entry: entryPath } = paths(env);
  await mkdir(library, { recursive: true, mode: 0o700 });
  const meta = await readJson(metaPath);
  const entries = Array.isArray(meta.entries) ? meta.entries.filter(isEntry) : [];
  let entry = entries.find((candidate) => candidate.name === PROFILE_NAME);
  if (!entry) { entry = { id: randomUUID(), name: PROFILE_NAME }; entries.push(entry); }
  const existing = await readJson(entryPath(entry.id));
  await writeJson(entryPath(entry.id), { ...existing, ...buildProfile(gatewayUrl, env.helperPath, modelIds, env.displayName) });
  await writeJson(metaPath, { ...meta, appliedId: entry.id, entries });
  const config = await readJson(configPath);
  if (config.deploymentMode !== "3p") await writeJson(configPath, { ...config, deploymentMode: "3p" });

  return statusAfterWrite(gatewayUrl, env, wasRunning, options);
}

/** Flips Claude Desktop between Claude.ai (1p) and this gateway (3p) the way its own chooser does: persist the mode, relaunch. The profile is left in place. */
export async function setDeploymentMode(gatewayUrl: string, mode: DeploymentMode, env: ClaudeDesktopEnvironment, options: { relaunch?: boolean } = {}): Promise<ClaudeDesktopSetupResult> {
  if (env.platform !== "darwin") throw new GatewayError("INVALID_REQUEST", "Claude Desktop setup is only available on macOS", 400);
  const wasRunning = await isRunning(env);
  if (wasRunning) await quitClaude(env); // Claude Desktop rewrites the config on quit, which would undo a write made while it runs.
  const configPath = paths(env).config;
  const config = await readJson(configPath);
  if (config.deploymentMode !== mode) await writeJson(configPath, { ...config, deploymentMode: mode });
  return statusAfterWrite(gatewayUrl, env, wasRunning, options);
}

async function statusAfterWrite(gatewayUrl: string, env: ClaudeDesktopEnvironment, wasRunning: boolean, options: { relaunch?: boolean }): Promise<ClaudeDesktopSetupResult> {
  const status = await claudeDesktopStatus(gatewayUrl, env);
  const relaunched = options.relaunch !== false && status.installed && (await env.run("open", ["-b", CLAUDE_BUNDLE_ID])).code === 0;
  return { ...status, running: relaunched || status.running, wasRunning, relaunched };
}
