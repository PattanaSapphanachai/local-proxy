import { app, BrowserWindow, clipboard, dialog, Menu, nativeImage, shell, Tray } from "electron";
import { spawn } from "node:child_process";
import { constants, copyFileSync, openSync } from "node:fs";
import { access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { startGateway, type RunningGateway } from "../src/app.ts";
import { findUpdate, type AvailableUpdate } from "../src/updates.ts";

const APP_NAME = "Local Proxy";
app.setName(APP_NAME);

// Packaged: extraResources land next to the app bundle's Resources. Dev: paths are relative to the repo root.
const root = app.isPackaged ? process.resourcesPath : app.getAppPath();
const asset = (devPath: string, packagedPath: string): string => join(root, app.isPackaged ? packagedPath : devPath);
const configPath = process.env.GATEWAY_CONFIG ?? asset("electron/gateway.config.json", "gateway.config.json");
const uiDir = asset("ui", "ui");
const trayIconPath = asset("electron/assets/trayTemplate.png", "assets/trayTemplate.png");
// Per-user data: never inside the bundle, survives app updates.
const userData = app.getPath("userData");
const statePath = join(userData, "routing-state.json");
const userSettingsPath = join(userData, "user-settings.json");
const claudeHelperPath = join(userData, "claude-desktop-credential");
const host = process.env.GATEWAY_HOST ?? "127.0.0.1";
const port = Number(process.env.GATEWAY_PORT ?? 8787);
// Updates come from the GitHub releases `npm run release` publishes; the bundled scripts/install.sh applies them.
const RELEASE_REPO = process.env.LOCAL_PROXY_REPO ?? "PattanaSapphanachai/local-proxy";
const installerPath = asset("scripts/install.sh", "install.sh");
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

let running: RunningGateway | undefined;
let window: BrowserWindow | undefined;
let tray: Tray | undefined;
let quitting = false;
let lastError: string | undefined;
let availableUpdate: AvailableUpdate | undefined;
let announcedVersion: string | undefined;
let installing = false;

const describe = (error: unknown): string => error instanceof Error ? error.message : String(error);
function startupHint(message: string): string {
  if (message.includes("EADDRINUSE")) return `Port ${port} is already in use. Another copy of the gateway (for example one started with npm start) may be running. Quit it and retry, or launch this app with GATEWAY_PORT set to a free port.`;
  if (message.includes("ENOENT") && message.includes("gateway.config")) return `The default gateway configuration is missing: ${configPath}`;
  return message;
}

async function start(): Promise<void> {
  try {
    running = await startGateway({ configPath, statePath, userSettingsPath, uiDir, host, port, claudeDesktop: { helperPath: claudeHelperPath }, version: app.getVersion() });
    lastError = undefined;
    console.log(`AI gateway listening on ${running.url}`);
  } catch (error) {
    running = undefined; lastError = describe(error);
    console.error(`[gateway] failed to start: ${lastError}`);
  }
  refreshTray();
  if (running) { window?.loadURL(running.url); return; }
  const { response } = await dialog.showMessageBox({ type: "error", title: APP_NAME, message: "The gateway could not start", detail: startupHint(lastError ?? "Unknown error"), buttons: ["Retry", "Quit"], defaultId: 0, cancelId: 1 });
  if (response === 0) return start();
  quitting = true; app.quit();
}

async function stop(): Promise<void> {
  if (!running) return;
  const current = running; running = undefined;
  await current.close().catch((error) => console.warn(`[gateway] close failed: ${describe(error)}`));
  refreshTray();
}

async function restart(): Promise<void> { await stop(); await start(); }

function createWindow(): BrowserWindow {
  const created = new BrowserWindow({
    width: 920, height: 780, minWidth: 420, minHeight: 480, title: APP_NAME, show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  created.once("ready-to-show", () => created.show());
  created.on("close", (event) => { if (!quitting) { event.preventDefault(); created.hide(); } });
  created.on("closed", () => { if (window === created) window = undefined; });
  created.webContents.setWindowOpenHandler(({ url }) => { void shell.openExternal(url); return { action: "deny" }; });
  if (running) void created.loadURL(running.url);
  return created;
}

function showWindow(): void {
  if (!window) window = createWindow();
  window.show(); window.focus();
}

// The folder holding this .app, so the update replaces the copy the user actually runs.
// A translocated copy (opened straight from a download) lives in a read-only path, so it updates into /Applications.
function installDir(): string {
  const bundle = resolve(app.getPath("exe"), "../../..");
  return bundle.includes("/AppTranslocation/") ? "/Applications" : dirname(bundle);
}

async function canInstallWithoutPassword(dir: string): Promise<boolean> {
  try {
    await access(dir, constants.W_OK);
    await access(join(dir, `${APP_NAME}.app`), constants.W_OK).catch((error) => { if (error?.code !== "ENOENT") throw error; });
    return true;
  } catch { return false; }
}

async function installUpdate(update: AvailableUpdate): Promise<void> {
  const dir = installDir();
  if (!(await canInstallWithoutPassword(dir))) {
    // The installer would need sudo, which has no terminal to ask in here; the release page lets the user update by hand.
    await dialog.showMessageBox({ type: "info", title: APP_NAME, message: `${APP_NAME} cannot update itself in ${dir}`,
      detail: "That folder needs an administrator password. The release page will open so you can download the new version, or run the install command from the README in Terminal.", buttons: ["Open Release Page"] });
    void shell.openExternal(update.pageUrl); return;
  }
  installing = true; refreshTray();
  const logPath = join(userData, "update.log");
  // Run a copy: the installer deletes the old bundle, which is where the packaged script lives.
  const script = join(userData, "install-update.sh");
  try { copyFileSync(installerPath, script); } catch (error) {
    installing = false; refreshTray();
    await dialog.showMessageBox({ type: "error", title: APP_NAME, message: "The update could not start", detail: describe(error) }); return;
  }
  const log = openSync(logPath, "w");
  // Detached so it outlives this app: the installer quits the app, swaps the bundle, and opens the new version.
  const child = spawn("/bin/bash", [script], {
    detached: true, stdio: ["ignore", log, log],
    env: { ...process.env, LOCAL_PROXY_VERSION: update.version, LOCAL_PROXY_REPO: RELEASE_REPO, LOCAL_PROXY_INSTALL_DIR: dir }
  });
  child.on("error", (error) => { installing = false; refreshTray(); void dialog.showMessageBox({ type: "error", title: APP_NAME, message: "The update could not start", detail: describe(error) }); });
  child.on("exit", (code) => {
    // Normally the installer quits this app before it exits; still being here means it failed.
    if (code === 0) return;
    installing = false; refreshTray();
    void dialog.showMessageBox({ type: "error", title: APP_NAME, message: "The update failed", detail: `The installer stopped with code ${code}. Details are in ${logPath}.`, buttons: ["Open Release Page", "OK"], defaultId: 1 })
      .then(({ response }) => { if (response === 0) void shell.openExternal(update.pageUrl); });
  });
  child.unref();
}

async function offerUpdate(update: AvailableUpdate): Promise<void> {
  const { response } = await dialog.showMessageBox({
    type: "info", title: APP_NAME, message: `${APP_NAME} ${update.version} is available`,
    detail: `You have ${app.getVersion()}. Updating quits ${APP_NAME}, installs the new version, and opens it again. Your API key and settings are kept.`,
    buttons: ["Update Now", "Later", "What's New"], defaultId: 0, cancelId: 1
  });
  if (response === 0) await installUpdate(update);
  else if (response === 2) void shell.openExternal(update.pageUrl);
}

// interactive: the user picked "Check for Updates…", so report "up to date" and errors instead of staying quiet.
async function checkForUpdates(interactive = false): Promise<void> {
  if (installing) return;
  try {
    availableUpdate = await findUpdate({ repo: RELEASE_REPO, currentVersion: app.getVersion(), arch: process.arch });
  } catch (error) {
    if (interactive) await dialog.showMessageBox({ type: "warning", title: APP_NAME, message: "Could not check for updates", detail: describe(error) });
    return;
  }
  refreshTray();
  if (!availableUpdate) {
    if (interactive) await dialog.showMessageBox({ type: "info", title: APP_NAME, message: `${APP_NAME} ${app.getVersion()} is the latest version.` });
    return;
  }
  // Background checks ask once per version per run; "Later" leaves the tray item for when the user is ready.
  if (interactive || announcedVersion !== availableUpdate.version) { announcedVersion = availableUpdate.version; await offerUpdate(availableUpdate); }
}

function refreshTray(): void {
  if (!tray) {
    const icon = nativeImage.createFromPath(trayIconPath); icon.setTemplateImage(true);
    tray = new Tray(icon);
  }
  const status = running ? `Running on ${running.url}` : `Stopped${lastError ? `: ${lastError}` : ""}`;
  tray.setToolTip(`${APP_NAME} – ${status}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `${APP_NAME} ${app.getVersion()}`, enabled: false },
    { label: status, enabled: false },
    { type: "separator" },
    installing ? { label: "Installing update…", enabled: false }
      : availableUpdate ? { label: `Update to ${availableUpdate.version}…`, click: () => { if (availableUpdate) void offerUpdate(availableUpdate); } }
      : { label: "Check for Updates…", enabled: app.isPackaged, click: () => { void checkForUpdates(true); } },
    { type: "separator" },
    { label: "Open Control Panel", click: showWindow },
    { label: "Copy Gateway Address", enabled: Boolean(running), click: () => { if (running) clipboard.writeText(running.url); } },
    { label: "Restart Gateway", click: () => { void restart(); } },
    { type: "separator" },
    { label: "Launch at Login", type: "checkbox", checked: app.getLoginItemSettings().openAtLogin, click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }) },
    { type: "separator" },
    { label: `Quit ${APP_NAME}`, click: () => { quitting = true; app.quit(); } }
  ]));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showWindow);
  app.on("activate", showWindow);
  app.on("window-all-closed", () => { /* keep running in the menu bar */ });
  app.on("before-quit", (event) => {
    quitting = true;
    if (running) { event.preventDefault(); void stop().then(() => app.quit()); }
  });
  void app.whenReady().then(async () => {
    await start();
    if (running) showWindow();
    // Development runs (npm run app:dev) have no installed bundle to replace.
    if (app.isPackaged) { void checkForUpdates(); setInterval(() => { void checkForUpdates(); }, UPDATE_CHECK_INTERVAL_MS); }
  });
}
