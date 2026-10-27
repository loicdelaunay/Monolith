import { spawn } from 'node:child_process';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HarnessError, type SecretProtectionInfo } from '@monolith/contracts';
import type { Database } from '../storage/database.ts';
import type { Logger } from '../log/logger.ts';
import { registerSecret } from './redact.ts';

/** Protège la clé maître à l'aide d'un mécanisme du système. */
export interface KeyProtector {
  readonly mechanism: SecretProtectionInfo['mechanism'];
  readonly systemBacked: boolean;
  isAvailable(): Promise<boolean>;
  /** Retourne les données à persister dans `keys/master.json`. */
  protect(key: Buffer, keyId: string): Promise<string>;
  unprotect(stored: string, keyId: string): Promise<Buffer>;
}

function run(cmd: string, args: string[], input: string, timeoutMs = 15_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${cmd} : délai dépassé`));
    }, timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

/** Windows : DPAPI (portée utilisateur) via Windows PowerShell 5.1, données passées par stdin. */
export class DpapiProtector implements KeyProtector {
  readonly mechanism = 'dpapi' as const;
  readonly systemBacked = true;
  private static readonly ps = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;

  async isAvailable(): Promise<boolean> {
    return process.platform === 'win32' && existsSync(DpapiProtector.ps);
  }

  private async call(op: 'Protect' | 'Unprotect', b64: string): Promise<string> {
    const script = `$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security;$i=[Console]::In.ReadToEnd().Trim();$b=[Convert]::FromBase64String($i);[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::${op}($b,$null,'CurrentUser'))`;
    const r = await run(DpapiProtector.ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], b64);
    if (r.code !== 0) throw new Error(`DPAPI ${op} : ${r.stderr.trim() || r.code}`);
    return r.stdout.trim();
  }

  async protect(key: Buffer): Promise<string> {
    return this.call('Protect', key.toString('base64'));
  }

  async unprotect(stored: string): Promise<Buffer> {
    return Buffer.from(await this.call('Unprotect', stored), 'base64');
  }
}

/** Linux : trousseau Secret Service (GNOME Keyring, KWallet…) via `secret-tool`. */
export class LibsecretProtector implements KeyProtector {
  readonly mechanism = 'libsecret' as const;
  readonly systemBacked = true;

  async isAvailable(): Promise<boolean> {
    if (process.platform !== 'linux') return false;
    try {
      const r = await run('secret-tool', ['--version'], '', 5000);
      return r.code === 0 || r.stdout.length > 0 || r.stderr.length > 0;
    } catch {
      return false;
    }
  }

  async protect(key: Buffer, keyId: string): Promise<string> {
    const r = await run('secret-tool', ['store', '--label=Monolith Harness', 'application', 'monolith-harness', 'key-id', keyId], key.toString('base64'));
    if (r.code !== 0) throw new Error(`secret-tool store : ${r.stderr.trim() || r.code}`);
    return 'libsecret';
  }

  async unprotect(_stored: string, keyId: string): Promise<Buffer> {
    const r = await run('secret-tool', ['lookup', 'application', 'monolith-harness', 'key-id', keyId], '');
    if (r.code !== 0 || !r.stdout.trim()) throw new Error('Clé absente du trousseau Secret Service');
    return Buffer.from(r.stdout.trim(), 'base64');
  }
}

/** macOS : Trousseau via `security -i` (commandes passées par stdin). Non vérifié sur matériel Apple. */
export class KeychainProtector implements KeyProtector {
  readonly mechanism = 'keychain' as const;
  readonly systemBacked = true;

  async isAvailable(): Promise<boolean> {
    return process.platform === 'darwin' && existsSync('/usr/bin/security');
  }

  async protect(key: Buffer, keyId: string): Promise<string> {
    const r = await run('/usr/bin/security', ['-i'], `add-generic-password -U -s "Monolith Harness" -a "${keyId}" -w "${key.toString('hex')}"\n`);
    if (r.code !== 0) throw new Error(`security : ${r.stderr.trim() || r.code}`);
    return 'keychain';
  }

  async unprotect(_stored: string, keyId: string): Promise<Buffer> {
    const r = await run('/usr/bin/security', ['find-generic-password', '-s', 'Monolith Harness', '-a', keyId, '-w'], '');
    if (r.code !== 0) throw new Error('Clé absente du Trousseau');
    return Buffer.from(r.stdout.trim(), 'hex');
  }
}

/** Repli explicite : clé dans un fichier aux permissions restreintes. N'est PAS une protection système. */
export class FileProtector implements KeyProtector {
  readonly mechanism = 'file' as const;
  readonly systemBacked = false;
  async isAvailable(): Promise<boolean> {
    return true;
  }
  async protect(key: Buffer): Promise<string> {
    return key.toString('base64');
  }
  async unprotect(stored: string): Promise<Buffer> {
    return Buffer.from(stored, 'base64');
  }
}

/** Tests uniquement. */
export class MemoryProtector extends FileProtector {
  override readonly mechanism = 'file' as const;
}

export function systemProtector(platform: NodeJS.Platform = process.platform): KeyProtector | null {
  if (platform === 'win32') return new DpapiProtector();
  if (platform === 'linux') return new LibsecretProtector();
  if (platform === 'darwin') return new KeychainProtector();
  return null;
}

interface MasterFile {
  version: 1;
  keyId: string;
  mechanism: SecretProtectionInfo['mechanism'];
  data: string;
  check: string;
}

export interface SecretStoreOptions {
  db: Database;
  keysDir: string;
  logger: Logger;
  protector: KeyProtector | null;
  /** Autorise le repli fichier lorsque aucun mécanisme système n'est disponible (choix explicite). */
  allowFileFallback: boolean;
}

/**
 * Coffre des secrets : AES-256-GCM avec une clé maître protégée par le système.
 * Le déverrouillage est paresseux (premier secret lu ou écrit) pour ne pas ralentir le démarrage.
 */
export class SecretStore {
  private keyPromise: Promise<Buffer> | null = null;
  private protectorInUse: KeyProtector | null = null;
  private lastError: string | null = null;

  constructor(private readonly options: SecretStoreOptions) {}

  private get file(): string {
    return join(this.options.keysDir, 'master.json');
  }

  async info(): Promise<SecretProtectionInfo> {
    const p = this.protectorInUse ?? (await this.pickProtector().catch(() => null));
    if (!p) {
      return {
        mechanism: 'none',
        systemBacked: false,
        available: false,
        message: this.lastError ?? 'Aucun mécanisme de protection système disponible. Installez un trousseau Secret Service (secret-tool) ou autorisez explicitement le repli fichier.',
      };
    }
    return {
      mechanism: p.mechanism,
      systemBacked: p.systemBacked,
      available: this.lastError === null,
      message: this.lastError ?? (p.systemBacked ? 'Clés chiffrées, clé maître protégée par le système.' : 'Repli fichier : la clé maître est protégée uniquement par les permissions du fichier.'),
    };
  }

  private async pickProtector(): Promise<KeyProtector | null> {
    const existing = this.readMaster();
    const sys = this.options.protector;
    if (existing) {
      if (existing.mechanism === 'file') return new FileProtector();
      return sys && sys.mechanism === existing.mechanism ? sys : null;
    }
    if (sys && (await sys.isAvailable())) return sys;
    return this.options.allowFileFallback ? new FileProtector() : null;
  }

  private readMaster(): MasterFile | null {
    if (!existsSync(this.file)) return null;
    try {
      return JSON.parse(readFileSync(this.file, 'utf8')) as MasterFile;
    } catch {
      return null;
    }
  }

  private key(): Promise<Buffer> {
    if (!this.keyPromise) {
      this.keyPromise = this.loadOrCreate().catch((error: unknown) => {
        this.keyPromise = null;
        throw error;
      });
    }
    return this.keyPromise;
  }

  private async loadOrCreate(): Promise<Buffer> {
    const protector = await this.pickProtector();
    if (!protector) {
      this.lastError = 'Aucun mécanisme de protection des clés disponible sur ce système.';
      throw new HarnessError('secret_unavailable', this.lastError);
    }
    this.protectorInUse = protector;
    const master = this.readMaster();
    if (master) {
      try {
        const key = await protector.unprotect(master.data, master.keyId);
        if (createHash('sha256').update(key).digest('hex').slice(0, 16) !== master.check) throw new Error('empreinte invalide');
        this.lastError = null;
        return key;
      } catch (error) {
        this.lastError = 'La clé maître ne peut pas être déchiffrée par ce compte ou ce poste. Les clés enregistrées doivent être ressaisies.';
        this.options.logger.warn('secrets', 'Clé maître illisible', { error: (error as Error).message });
        throw new HarnessError('secret_unreadable', this.lastError);
      }
    }
    const key = randomBytes(32);
    const keyId = randomBytes(12).toString('hex');
    const data = await protector.protect(key, keyId);
    const file: MasterFile = { version: 1, keyId, mechanism: protector.mechanism, data, check: createHash('sha256').update(key).digest('hex').slice(0, 16) };
    mkdirSync(this.options.keysDir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
    try {
      chmodSync(this.file, 0o600);
    } catch {
      /* Windows : ACL héritées du dossier */
    }
    this.lastError = null;
    this.options.logger.info('secrets', 'Clé maître créée', { mechanism: protector.mechanism });
    return key;
  }

  /** Remplace une clé maître illisible : les secrets existants deviennent irrécupérables et sont supprimés. */
  async resetMasterKey(): Promise<void> {
    const backup = `${this.file}.unreadable-${Date.now()}`;
    if (existsSync(this.file)) renameSync(this.file, backup);
    this.options.db.run('DELETE FROM secrets');
    this.keyPromise = null;
    this.lastError = null;
    await this.key();
  }

  async set(id: string, plaintext: string): Promise<string> {
    const key = await this.key();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(id));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    const hint = plaintext.length >= 8 ? plaintext.slice(-4) : null;
    const now = new Date().toISOString();
    this.options.db.run(
      `INSERT INTO secrets (id, iv, tag, ciphertext, hint, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET iv = excluded.iv, tag = excluded.tag, ciphertext = excluded.ciphertext, hint = excluded.hint, updated_at = excluded.updated_at`,
      id, iv, tag, ciphertext, hint, now, now,
    );
    registerSecret(plaintext);
    return id;
  }

  async get(id: string): Promise<string | null> {
    const row = this.options.db.get<{ iv: Uint8Array; tag: Uint8Array; ciphertext: Uint8Array }>('SELECT iv, tag, ciphertext FROM secrets WHERE id = ?', id);
    if (!row) return null;
    const key = await this.key();
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(row.iv));
      decipher.setAAD(Buffer.from(id));
      decipher.setAuthTag(Buffer.from(row.tag));
      const plain = Buffer.concat([decipher.update(Buffer.from(row.ciphertext)), decipher.final()]).toString('utf8');
      registerSecret(plain);
      return plain;
    } catch {
      throw new HarnessError('secret_unreadable', 'Ce secret ne peut pas être déchiffré ; ressaisissez-le.');
    }
  }

  hint(id: string): string | null {
    return this.options.db.get<{ hint: string | null }>('SELECT hint FROM secrets WHERE id = ?', id)?.hint ?? null;
  }

  delete(id: string): void {
    this.options.db.run('DELETE FROM secrets WHERE id = ?', id);
  }

  /** Vrai si la clé maître existe mais n'a pas pu être déchiffrée. */
  get unreadable(): boolean {
    return this.lastError !== null && existsSync(this.file);
  }
}
