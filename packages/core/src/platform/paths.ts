import { accessSync, constants, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export type DataDirSource = 'argument' | 'environment' | 'location-file' | 'portable' | 'user';

export interface ResolveDataDirOptions {
  /** Dossier explicite (`--data-dir`). */
  explicit?: string | null;
  /** Dossier contenant l'exécutable (portable). */
  exeDir: string | null;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

export interface ResolvedDataDir {
  dir: string;
  source: DataDirSource;
  portable: boolean;
  /** Fichier de redirection lu, le cas échéant. */
  locationFile: string | null;
}

export const LOCATION_FILE = 'monolith.location.json';

export function userDataRoot(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  if (platform === 'win32') return join(env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'MonolithHarness');
  if (platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'MonolithHarness');
  return join(env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'monolith-harness');
}

function userConfigLocationFile(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
  return join(userDataRoot(platform, env), LOCATION_FILE);
}

export function isWritableDir(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true });
    accessSync(dir, constants.W_OK);
    const probe = join(dir, `.write-test-${process.pid}`);
    writeFileSync(probe, '');
    rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

function readLocationFile(file: string): string | null {
  try {
    if (!existsSync(file)) return null;
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { dataDir?: unknown };
    if (typeof parsed.dataDir !== 'string' || parsed.dataDir.trim() === '') return null;
    return isAbsolute(parsed.dataDir) ? parsed.dataDir : resolve(dirname(file), parsed.dataDir);
  } catch {
    return null;
  }
}

/**
 * Ordre : argument → variable d'environnement → fichier de redirection (à côté de l'exécutable,
 * puis dans le dossier utilisateur) → `data/` portable à côté de l'exécutable s'il est inscriptible
 * → dossier utilisateur du système.
 */
export function resolveDataDir(options: ResolveDataDirOptions): ResolvedDataDir {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  if (options.explicit) return { dir: resolve(options.explicit), source: 'argument', portable: false, locationFile: null };
  if (env.MONOLITH_DATA_DIR) return { dir: resolve(env.MONOLITH_DATA_DIR), source: 'environment', portable: false, locationFile: null };

  const locationFiles = [
    ...(options.exeDir ? [join(options.exeDir, LOCATION_FILE)] : []),
    userConfigLocationFile(platform, env),
  ];
  for (const file of locationFiles) {
    const dir = readLocationFile(file);
    if (dir) return { dir, source: 'location-file', portable: false, locationFile: file };
  }

  if (options.exeDir) {
    const portableDir = join(options.exeDir, 'data');
    if (isWritableDir(portableDir)) return { dir: portableDir, source: 'portable', portable: true, locationFile: null };
  }
  return { dir: userDataRoot(platform, env), source: 'user', portable: false, locationFile: null };
}

/**
 * Enregistre un emplacement alternatif. Écrit à côté de l'exécutable si possible, sinon dans le
 * dossier utilisateur. Prend effet au prochain démarrage ; les données existantes ne sont ni
 * déplacées ni supprimées.
 */
export function writeLocationFile(exeDir: string | null, dataDir: string | null): string {
  const target = exeDir && isWritableDir(exeDir) ? join(exeDir, LOCATION_FILE) : userConfigLocationFile(process.platform, process.env);
  mkdirSync(dirname(target), { recursive: true });
  if (dataDir === null) rmSync(target, { force: true });
  else writeFileSync(target, JSON.stringify({ dataDir: resolve(dataDir) }, null, 2) + '\n');
  return target;
}

export interface DataLayout {
  root: string;
  database: string;
  keys: string;
  workspace: string;
  conversations: string;
  attachments: string;
  skills: string;
  logs: string;
  backups: string;
  temp: string;
}

export function dataLayout(root: string): DataLayout {
  const workspace = join(root, 'workspace');
  return {
    root,
    database: join(root, 'monolith.sqlite'),
    keys: join(root, 'keys'),
    workspace,
    conversations: join(workspace, 'conversations'),
    attachments: join(workspace, 'attachments'),
    skills: join(workspace, 'skills'),
    logs: join(workspace, 'logs'),
    backups: join(workspace, 'backups'),
    temp: join(workspace, 'temp'),
  };
}

export function ensureLayout(layout: DataLayout): void {
  for (const dir of [layout.root, layout.keys, layout.workspace, layout.conversations, layout.attachments, layout.skills, layout.logs, layout.backups, layout.temp]) {
    mkdirSync(dir, { recursive: true });
  }
}
