import { app, BrowserWindow, clipboard, dialog, Menu, nativeImage, shell, Tray } from "electron";
import { join } from "node:path";
import { startGateway, type RunningGateway } from "../src/app.ts";

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

let running: RunningGateway | undefined;
let window: BrowserWindow | undefined;
let tray: Tray | undefined;
let quitting = false;
let lastError: string | undefined;

const describe = (error: unknown): string => error instanceof Error ? error.message : String(error);
function startupHint(message: string): string {
  if (message.includes("EADDRINUSE")) return `Port ${port} is already in use. Another copy of the gateway (for example one started with npm start) may be running. Quit it and retry, or launch this app with GATEWAY_PORT set to a free port.`;
  if (message.includes("ENOENT") && message.includes("gateway.config")) return `The default gateway configuration is missing: ${configPath}`;
  return message;
}

async function start(): Promise<void> {
  try {
    running = await startGateway({ configPath, statePath, userSettingsPath, uiDir, host, port, claudeDesktop: { helperPath: claudeHelperPath } });
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

function refreshTray(): void {
  if (!tray) {
    const icon = nativeImage.createFromPath(trayIconPath); icon.setTemplateImage(true);
    tray = new Tray(icon);
  }
  const status = running ? `Running on ${running.url}` : `Stopped${lastError ? `: ${lastError}` : ""}`;
  tray.setToolTip(`${APP_NAME} – ${status}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: status, enabled: false },
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
  });
}
