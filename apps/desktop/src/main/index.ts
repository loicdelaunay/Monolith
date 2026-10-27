// Processus principal Electron : fenêtres, barre de titre, dialogues natifs et cycle de vie du
// moteur. Aucune requête SQL ni aucun streaming ici : le moteur tourne dans un utilityProcess.
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, Notification, screen, session, shell, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import { applyLaunch, readLaunch, writeLaunch } from './launch.ts';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { EngineHost } from './engine-host.ts';
import { BrowserManager } from './browser.ts';
import type { RendererInfo } from '../shared/bridge.ts';

const TITLE_BAR_HEIGHT = 40;
const isDev = !app.isPackaged;

/** Dossier de l'exécutable pour le mode portable ; null pour une installation (NSIS) ou en développement. */
function portableExeDir(): string | null {
  if (isDev) return null;
  if (process.env.PORTABLE_EXECUTABLE_DIR) return process.env.PORTABLE_EXECUTABLE_DIR;
  if (process.platform === 'linux' && process.env.APPIMAGE) return dirname(process.env.APPIMAGE);
  const dir = dirname(process.execPath);
  // Installation NSIS : les données iraient dans le dossier d'installation, supprimé à la désinstallation.
  if (existsSync(join(dir, `Uninstall ${app.getName()}.exe`))) return null;
  return dir;
}

const devDataDir = isDev ? resolve(app.getAppPath(), '../../.data/desktop') : null;
const engine = new EngineHost({
  entry: join(__dirname, 'engine.js'),
  env: {
    ...(portableExeDir() ? { MONOLITH_EXE_DIR: portableExeDir()! } : {}),
    ...(process.env.MONOLITH_DATA_DIR ? { MONOLITH_DATA_DIR: process.env.MONOLITH_DATA_DIR } : devDataDir ? { MONOLITH_DATA_DIR: devDataDir } : {}),
    ...(isDev ? { MONOLITH_DEV: '1' } : {}),
  },
});

let mainWindow: BrowserWindow | null = null;

// Réglages de rendu : lus avant le démarrage de Chromium, à côté des données (portable) ou du profil.
const launchFile = join(portableExeDir() ? join(portableExeDir()!, 'data') : (process.env.MONOLITH_DATA_DIR ?? devDataDir ?? app.getPath('userData')), 'launch.json');
const launchApplied = applyLaunch(launchFile);

const browser = new BrowserManager(
  () => mainWindow,
  (tabs, activeId, notice) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('browser:state', { tabs, activeId, notice: notice ?? null });
  },
);
engine.hostHandler = (method, params) => browser.hostRequest(method, params);

interface WindowState {
  width: number;
  height: number;
  x?: number;
  y?: number;
  maximized: boolean;
}

function windowStateFile(): string | null {
  return engine.dataDir ? join(engine.dataDir, 'window-state.json') : null;
}

function loadWindowState(): WindowState {
  const fallback: WindowState = { width: 1280, height: 820, maximized: false };
  const file = windowStateFile();
  if (!file || !existsSync(file)) return fallback;
  try {
    const s = JSON.parse(readFileSync(file, 'utf8')) as WindowState;
    const visible = screen.getAllDisplays().some((d) => s.x !== undefined && s.y !== undefined && s.x < d.bounds.x + d.bounds.width - 80 && s.x + s.width > d.bounds.x + 80 && s.y >= d.bounds.y - 10 && s.y < d.bounds.y + d.bounds.height - 40);
    return { width: Math.max(720, s.width), height: Math.max(480, s.height), maximized: !!s.maximized, ...(visible ? { x: s.x!, y: s.y! } : {}) };
  } catch {
    return fallback;
  }
}

function saveWindowState(win: BrowserWindow): void {
  const file = windowStateFile();
  if (!file || win.isDestroyed()) return;
  const b = win.getNormalBounds();
  try {
    writeFileSync(file, JSON.stringify({ width: b.width, height: b.height, x: b.x, y: b.y, maximized: win.isMaximized() }));
  } catch {
    /* dossier en lecture seule : état non conservé */
  }
}

function createWindow(): BrowserWindow {
  const state = loadWindowState();
  const dark = nativeTheme.shouldUseDarkColors;
  const custom = engine.titleBar === 'custom' && process.platform !== 'darwin';
  const base: Electron.BrowserWindowConstructorOptions = {
    width: state.width,
    height: state.height,
    ...(state.x !== undefined ? { x: state.x, y: state.y } : {}),
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: 'Monolith Harness',
    backgroundColor: dark ? '#111214' : '#f7f7f8',
    icon: join(__dirname, '../../build/icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: true,
      backgroundThrottling: true,
    },
  };
  let win: BrowserWindow;
  try {
    win = new BrowserWindow(
      custom
        ? { ...base, titleBarStyle: 'hidden', titleBarOverlay: { color: dark ? '#111214' : '#f7f7f8', symbolColor: dark ? '#e6e6e8' : '#26272b', height: TITLE_BAR_HEIGHT } }
        : base,
    );
    customTitleBarActive = custom;
  } catch {
    // Repli système : cadre natif si la superposition n'est pas prise en charge.
    win = new BrowserWindow(base);
    customTitleBarActive = false;
  }
  if (state.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());
  win.on('close', () => saveWindowState(win));

  // Navigation verrouillée : l'interface ne quitte jamais son document ; les liens externes s'ouvrent dans le navigateur.
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) event.preventDefault();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (process.env.MONOLITH_SMOKE_SHOT) smokeCapture(win, process.env.MONOLITH_SMOKE_SHOT);

  if (isDev && process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(join(__dirname, '../renderer/index.html'));
  return win;
}

let customTitleBarActive = false;

/**
 * Test visuel sur la fenêtre réelle : capture PNG après chargement, puis fermeture.
 * Activé uniquement par variables d'environnement (scripts de test), jamais par l'interface.
 */
function smokeCapture(win: BrowserWindow, target: string): void {
  const steps = (process.env.MONOLITH_SMOKE_STEPS ?? '').split('|||').filter(Boolean);
  win.webContents.on('console-message', (event) => {
    if (event.level === 'error' || event.level === 'warning') console.log('CONSOLE', event.level, event.message.slice(0, 400));
  });
  win.webContents.once('did-finish-load', async () => {
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    await wait(Number(process.env.MONOLITH_SMOKE_DELAY ?? 2500));
    for (const [index, step] of steps.entries()) {
      const result: unknown = await win.webContents.executeJavaScript(step).catch((e: unknown) => `smoke step failed: ${String(e)}`);
      if (result !== undefined) console.log('SMOKE', index + 1, JSON.stringify(result));
      await wait(900);
      const image = await win.webContents.capturePage();
      writeFileSync(target.replace(/\.png$/, `-${index + 1}.png`), image.toPNG());
      const view = await browser.captureVisible();
      if (view && !view.isEmpty()) writeFileSync(target.replace(/\.png$/, `-${index + 1}-browser.png`), view.toPNG());
    }
    const image = await win.webContents.capturePage();
    writeFileSync(target, image.toPNG());
    app.quit();
  });
}

function fromOurWindow(event: IpcMainEvent | IpcMainInvokeEvent): BrowserWindow | null {
  const win = BrowserWindow.fromWebContents(event.sender);
  return win && win === mainWindow ? win : null;
}

function registerIpc(): void {
  ipcMain.on('engine:request-port', (event) => {
    if (!fromOurWindow(event)) return;
    engine.connect(event.sender);
  });
  ipcMain.handle('host:info', (event): RendererInfo | null => {
    if (!fromOurWindow(event)) return null;
    return {
      platform: process.platform,
      customTitleBar: customTitleBarActive,
      titleBarHeight: TITLE_BAR_HEIGHT,
      controlsWidth: customTitleBarActive ? 138 : 0,
      isPackaged: app.isPackaged,
      locale: app.getLocale(),
    };
  });
  ipcMain.handle('host:pickDirectory', async (event, title: unknown) => {
    const win = fromOurWindow(event);
    if (!win) return null;
    const r = await dialog.showOpenDialog(win, { title: typeof title === 'string' ? title : undefined, properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });
  ipcMain.handle('host:pickFiles', async (event, title: unknown) => {
    const win = fromOurWindow(event);
    if (!win) return [];
    const r = await dialog.showOpenDialog(win, { title: typeof title === 'string' ? title : undefined, properties: ['openFile', 'multiSelections'] });
    return r.canceled ? [] : r.filePaths;
  });
  ipcMain.handle('host:openExternal', async (event, url: unknown) => {
    if (!fromOurWindow(event) || typeof url !== 'string' || !/^https?:\/\//i.test(url)) return false;
    await shell.openExternal(url);
    return true;
  });
  ipcMain.handle('host:showItemInFolder', (event, path: unknown) => {
    if (fromOurWindow(event) && typeof path === 'string') shell.showItemInFolder(path);
  });
  // Écriture uniquement vers un chemin choisi par l'utilisateur dans le dialogue natif.
  ipcMain.handle('host:saveTextFile', async (event, defaultName: unknown, content: unknown, filters: unknown) => {
    const win = fromOurWindow(event);
    if (!win || typeof content !== 'string' || content.length > 50 * 1024 * 1024) return null;
    const name = typeof defaultName === 'string' ? defaultName.replace(/[\\/:*?"<>|]/g, '_').slice(0, 120) : 'export.txt';
    const r = await dialog.showSaveDialog(win, { defaultPath: name, filters: Array.isArray(filters) ? (filters as Electron.FileFilter[]) : undefined });
    if (r.canceled || !r.filePath) return null;
    await writeFile(r.filePath, content, 'utf8');
    return r.filePath;
  });
  // Écriture binaire (PNG exportés…) uniquement vers un chemin choisi dans le dialogue natif.
  ipcMain.handle('host:saveBinaryFile', async (event, defaultName: unknown, dataBase64: unknown, filters: unknown) => {
    const win = fromOurWindow(event);
    if (!win || typeof dataBase64 !== 'string' || dataBase64.length > 70 * 1024 * 1024) return null;
    const name = typeof defaultName === 'string' ? defaultName.replace(/[\\/:*?"<>|]/g, '_').slice(0, 120) : 'export.bin';
    const r = await dialog.showSaveDialog(win, { defaultPath: name, filters: Array.isArray(filters) ? (filters as Electron.FileFilter[]) : undefined });
    if (r.canceled || !r.filePath) return null;
    await writeFile(r.filePath, Buffer.from(dataBase64, 'base64'));
    return r.filePath;
  });
  ipcMain.handle('host:setTitleBarColors', (event, colors: { background?: unknown; symbols?: unknown }) => {
    const win = fromOurWindow(event);
    if (!win || !customTitleBarActive) return;
    const hex = (v: unknown) => (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v : undefined);
    const color = hex(colors?.background);
    const symbolColor = hex(colors?.symbols);
    if (color && symbolColor) win.setTitleBarOverlay({ color, symbolColor, height: TITLE_BAR_HEIGHT });
  });
  ipcMain.on('browser:bounds', (event, bounds: unknown) => {
    if (!fromOurWindow(event)) return;
    const b = bounds as { x?: unknown; y?: unknown; width?: unknown; height?: unknown } | null;
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);
    if (!b) browser.setBounds(null);
    else if ([b.x, b.y, b.width, b.height].every((v) => !Number.isNaN(num(v)))) browser.setBounds({ x: num(b.x), y: num(b.y), width: num(b.width), height: num(b.height) });
  });
  ipcMain.handle('browser:command', async (event, cmd: unknown, args: unknown) => {
    if (!fromOurWindow(event) || typeof cmd !== 'string') return;
    await browser.command(cmd, args && typeof args === 'object' ? (args as Record<string, unknown>) : {});
  });
  ipcMain.handle('browser:state', (event) => (fromOurWindow(event) ? { tabs: browser.states(), activeId: browser.active, notice: null } : null));
  ipcMain.handle('host:notify', (event, title: unknown, body: unknown, silent: unknown) => {
    if (!fromOurWindow(event) || typeof title !== 'string' || !Notification.isSupported()) return false;
    const n = new Notification({ title: title.slice(0, 120), body: typeof body === 'string' ? body.slice(0, 400) : '', silent: silent === true, icon: join(__dirname, '../../build/icon.png') });
    n.on('click', () => {
      if (!mainWindow) return;
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    });
    n.show();
    return true;
  });
  ipcMain.handle('host:launch', (event, value: unknown) => {
    if (!fromOurWindow(event)) return null;
    const saved = value === undefined ? readLaunch(launchFile) : writeLaunch(launchFile, value);
    return { saved, applied: launchApplied };
  });
  ipcMain.handle('host:gpuInfo', async (event) => {
    if (!fromOurWindow(event)) return null;
    const basic = (await app.getGPUInfo('basic').catch(() => null)) as { gpuDevice?: { vendorId?: number; deviceId?: number; active?: boolean }[]; auxAttributes?: Record<string, unknown> } | null;
    const display = screen.getPrimaryDisplay();
    return {
      hardwareAcceleration: app.isHardwareAccelerationEnabled(),
      angle: app.commandLine.getSwitchValue('use-angle') || 'default',
      vsyncDisabled: app.commandLine.hasSwitch('disable-gpu-vsync'),
      featureStatus: app.getGPUFeatureStatus(),
      devices: basic?.gpuDevice?.map((d) => ({ vendorId: d.vendorId, deviceId: d.deviceId, active: d.active })) ?? [],
      glRenderer: (basic?.auxAttributes?.glRenderer as string | undefined) ?? null,
      displayHz: display.displayFrequency,
      scaleFactor: display.scaleFactor,
      versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
    };
  });
  ipcMain.handle('host:metrics', (event) => {
    if (!fromOurWindow(event)) return [];
    return app.getAppMetrics().map((m) => ({ pid: m.pid, type: m.type, name: m.name ?? m.serviceName ?? '', cpu: Math.round(m.cpu.percentCPUUsage * 10) / 10, memoryMb: Math.round(m.memory.workingSetSize / 1024) }));
  });
  ipcMain.handle('host:showPath', (event, path: unknown) => {
    if (fromOurWindow(event) && typeof path === 'string') shell.showItemInFolder(path);
  });
  ipcMain.handle('host:relaunch', (event) => {
    if (!fromOurWindow(event)) return;
    app.relaunch();
    app.quit();
  });
}

// Tests visuels : profil Chromium séparé et pas de verrou d'instance unique, pour ne jamais
// interférer avec une instance ouverte par l'utilisateur.
const smoke = !!process.env.MONOLITH_SMOKE_SHOT;
if (smoke) app.setPath('userData', join(app.getPath('temp'), `monolith-smoke-${process.pid}`));

if (!smoke && !app.requestSingleInstanceLock()) {
  // Une seule instance par profil : la base et les générations en cours appartiennent à la première.
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    // Aucune permission web (caméra, micro, notifications…) n'est accordée à l'interface.
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    registerIpc();
    try {
      await engine.start();
    } catch (error) {
      dialog.showErrorBox('Monolith Harness', `Le moteur n’a pas pu démarrer :\n${error instanceof Error ? error.message : String(error)}`);
      app.quit();
      return;
    }
    mainWindow = createWindow();
    mainWindow.on('closed', () => (mainWindow = null));
  });

  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => engine.stop());
}
