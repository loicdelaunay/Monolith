import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installerCommand, type UpdateJob } from '../src/main/updater.ts';

const dir = mkdtempSync(join(tmpdir(), 'mh-updater-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const job = (updates: string): UpdateJob => ({
  script: join(updates, 'apply-update.ps1'),
  zip: join(updates, 'MonolithHarness-v9.9.9-win-x64.zip'),
  sha256: 'a'.repeat(64),
  version: '9.9.9',
  when: 'now',
});

describe('lancement de l’installateur de mise à jour', () => {
  it('refuse un chemin que cmd.exe interpréterait', () => {
    expect(installerCommand(job('C:\\Apps\\Monolith\\data\\updates'), 'C:\\Apps\\Monolith', 'Monolith.exe', 1, true)).toMatch(/^start "" \/min ".*powershell\.exe" .*"-Relaunch"$/);
    expect(() => installerCommand(job('C:\\100%\\data\\updates'), 'C:\\100%', 'Monolith.exe', 1, false)).toThrow(/non pris en charge/);
  });

  // Régression : PowerShell lancé détaché quittait sans exécuter le script, et lancé en enfant direct il
  // était terminé avec l'application. L'installateur doit s'exécuter après la fermeture du processus parent.
  it.skipIf(process.platform !== 'win32')('l’installateur s’exécute après la fermeture de l’application', async () => {
    const updates = join(dir, 'app', 'data', 'updates');
    mkdirSync(updates, { recursive: true });
    const marker = join(dir, 'marker.txt');
    writeFileSync(
      join(updates, 'apply-update.ps1'),
      `param([int]$WaitPid = 0, [string]$Zip, [string]$Sha256, [string]$Target, [string]$Exe, [string]$Version, [switch]$Relaunch)
$p = Get-Process -Id $WaitPid -ErrorAction SilentlyContinue
if ($p) { [void]$p.WaitForExit(30000) }
$gone = -not (Get-Process -Id $WaitPid -ErrorAction SilentlyContinue)
Set-Content -LiteralPath '${marker}' -Value "gone=$gone version=$Version target=$Target"
`,
    );
    // Processus « application » : lance l'installateur puis se termine aussitôt, comme Monolith.
    const module = pathToFileURL(join(import.meta.dirname, '../src/main/updater.ts')).href;
    execFileSync(process.execPath, ['--input-type=module', '-e', `const m = await import(${JSON.stringify(module)}); m.launchInstaller(${JSON.stringify(job(updates))}, ${JSON.stringify(join(dir, 'app'))}, false); process.exit(0);`], { stdio: 'pipe' });
    for (let i = 0; i < 100 && !existsSync(marker); i++) await new Promise((r) => setTimeout(r, 200));
    expect(readFileSync(marker, 'utf8').trim()).toBe(`gone=True version=9.9.9 target=${join(dir, 'app')}`);
  }, 30_000);
});
