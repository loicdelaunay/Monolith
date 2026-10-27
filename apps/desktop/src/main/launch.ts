import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Réglages lus avant le démarrage de Chromium (accélération, moteur de rendu, synchronisation). */
export interface LaunchSettings {
  hardwareAcceleration: boolean;
  angle: 'default' | 'd3d11' | 'd3d9' | 'gl' | 'vulkan' | 'swiftshader';
  vsync: boolean;
}

export const DEFAULT_LAUNCH: LaunchSettings = { hardwareAcceleration: true, angle: 'default', vsync: true };
const ANGLES = ['default', 'd3d11', 'd3d9', 'gl', 'vulkan', 'swiftshader'];

export function readLaunch(file: string): LaunchSettings {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8')) as Partial<LaunchSettings>;
    return { hardwareAcceleration: j.hardwareAcceleration !== false, angle: ANGLES.includes(String(j.angle)) ? (j.angle as LaunchSettings['angle']) : 'default', vsync: j.vsync !== false };
  } catch {
    return { ...DEFAULT_LAUNCH };
  }
}

export function writeLaunch(file: string, value: unknown): LaunchSettings {
  const v = (value ?? {}) as Partial<LaunchSettings>;
  const clean: LaunchSettings = { hardwareAcceleration: v.hardwareAcceleration !== false, angle: ANGLES.includes(String(v.angle)) ? (v.angle as LaunchSettings['angle']) : 'default', vsync: v.vsync !== false };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(clean, null, 2), 'utf8');
  return clean;
}

/** À appeler avant `app.whenReady()` : les commutateurs de Chromium ne s'appliquent qu'au lancement. */
export function applyLaunch(file: string): LaunchSettings {
  const s = existsSync(file) ? readLaunch(file) : { ...DEFAULT_LAUNCH };
  if (!s.hardwareAcceleration) app.disableHardwareAcceleration();
  if (s.angle !== 'default') app.commandLine.appendSwitch('use-angle', s.angle);
  if (!s.vsync) {
    app.commandLine.appendSwitch('disable-gpu-vsync');
    app.commandLine.appendSwitch('disable-frame-rate-limit');
  }
  return s;
}
