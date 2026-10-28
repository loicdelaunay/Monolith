import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export interface UpdateJob {
  script: string;
  zip: string;
  sha256: string;
  version: string;
  when: 'now' | 'exit';
}

/** Installation programmée à la fermeture (mode automatique). */
let pending: UpdateJob | null = null;

/**
 * Installation demandée par le moteur : paquet téléchargé et vérifié dans le dossier updates des
 * données. L'hôte revérifie l'empreinte, lance l'installateur détaché puis ferme l'application.
 */
export async function installUpdate(params: Record<string, unknown>, exeDir: string | null, quit: () => void): Promise<{ scheduled: true }> {
  if (process.platform !== 'win32' || !exeDir) throw new Error('Installation possible seulement pour la version portable Windows.');
  const job = validate(params);
  if ((await sha256(job.zip)) !== job.sha256) throw new Error('Empreinte SHA-256 du paquet incorrecte.');
  if (job.when === 'exit') {
    pending = job;
    return { scheduled: true };
  }
  launchInstaller(job, exeDir, true);
  setTimeout(quit, 300);
  return { scheduled: true };
}

/** À la fermeture : installe la mise à jour programmée, sans relancer. */
export function runPendingUpdate(exeDir: string | null): void {
  if (pending && exeDir) launchInstaller(pending, exeDir, false);
  pending = null;
}

function validate(p: Record<string, unknown>): UpdateJob {
  const s = (k: string) => (typeof p[k] === 'string' ? (p[k] as string) : '');
  const job: UpdateJob = { script: s('script'), zip: s('zip'), sha256: s('sha256').toLowerCase(), version: s('version'), when: p.when === 'exit' ? 'exit' : 'now' };
  const ok =
    /^[0-9a-f]{64}$/.test(job.sha256) &&
    /^[0-9A-Za-z.-]+$/.test(job.version) &&
    basename(job.script) === 'apply-update.ps1' &&
    dirname(job.script) === dirname(job.zip) &&
    basename(dirname(job.zip)) === 'updates' &&
    /^MonolithHarness-v[0-9A-Za-z.-]+-win-x64\.zip$/.test(basename(job.zip)) &&
    existsSync(job.script) &&
    existsSync(job.zip);
  if (!ok) throw new Error('Demande d’installation invalide.');
  return job;
}

/** Arguments de l'installateur, sûrs entre guillemets pour cmd.exe (ni guillemet ni %). */
export function installerCommand(job: UpdateJob, exeDir: string, exe: string, pid: number, relaunch: boolean, systemRoot = 'C:\\Windows'): string {
  const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const args = [powershell, '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', job.script, '-WaitPid', String(pid), '-Zip', job.zip, '-Sha256', job.sha256, '-Target', exeDir, '-Exe', exe, '-Version', job.version];
  if (relaunch) args.push('-Relaunch');
  if (args.some((a) => /["%\r\n]/.test(a))) throw new Error('Dossier de Monolith non pris en charge pour la mise à jour automatique (caractère " ou % dans le chemin).');
  return `start "" /min ${args.map((a) => `"${a}"`).join(' ')}`;
}

export function launchInstaller(job: UpdateJob, exeDir: string, relaunch: boolean): void {
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  const command = installerCommand(job, exeDir, basename(process.execPath), process.pid, relaunch, systemRoot);
  // PSModulePath hérité de PowerShell 7 : il masquerait les modules de Windows PowerShell 5.1.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toLowerCase() !== 'psmodulepath'));
  // Ni enfant direct (Node le rattache à l'application, qui le termine en se fermant) ni PowerShell
  // détaché (sans console, il quitte sans exécuter le script) : cmd détaché le démarre via `start`,
  // avec sa propre console masquée, hors de l'application.
  spawn(join(systemRoot, 'System32', 'cmd.exe'), ['/d', '/s', '/c', `"${command}"`], { detached: true, stdio: 'ignore', windowsHide: true, env, windowsVerbatimArguments: true }).unref();
}

function sha256(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(file)
      .on('data', (c) => h.update(c))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject);
  });
}
