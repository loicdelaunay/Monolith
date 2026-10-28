import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { generateKeyPairSync, X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as tls from 'node:tls';
import { silentLogger } from '../src/log/logger.ts';
import { trustSystemCertificates } from '../src/net/certificates.ts';
import { HttpClient, ProviderError } from '../src/providers/http.ts';

// Chaînes de test générées par OpenSSL (présent sur les postes Git et les runners GitHub).
const OPENSSL = ['openssl', 'C:/Program Files/Git/usr/bin/openssl.exe', 'C:/Program Files/Git/mingw64/bin/openssl.exe', 'C:/Program Files/OpenSSL/bin/openssl.exe'].find(
  (bin) => spawnSync(bin, ['version'], { stdio: 'ignore' }).status === 0,
);

const dir = mkdtempSync(join(tmpdir(), 'mh-certs-'));
const servers: Server[] = [];
const aiaHits: string[] = [];

function openssl(...args: string[]): void {
  execFileSync(OPENSSL!, args, { cwd: dir, stdio: 'pipe', env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
}

function key(name: string): void {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  writeFileSync(join(dir, `${name}.key`), privateKey);
}

/** Racine → intermédiaire → serveur (127.0.0.1), l'intermédiaire publié à l'adresse AIA donnée. */
function pki(name: string, aia: string): { root: string; leaf: string; leafKey: string } {
  writeFileSync(join(dir, 'min.cnf'), '[req]\ndistinguished_name = dn\n[dn]\n');
  writeFileSync(join(dir, 'ca.ext'), 'basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n');
  writeFileSync(join(dir, `${name}-leaf.ext`), `basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1\nauthorityInfoAccess=caIssuers;URI:${aia}\n`);
  for (const k of ['root', 'int', 'leaf']) key(`${name}-${k}`);
  openssl('req', '-x509', '-new', '-config', 'min.cnf', '-key', `${name}-root.key`, '-subj', `/CN=MH Test Root ${name}`, '-days', '2', '-sha256', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign', '-out', `${name}-root.pem`);
  openssl('req', '-new', '-config', 'min.cnf', '-key', `${name}-int.key`, '-subj', `/CN=MH Test Intermediate ${name}`, '-out', `${name}-int.csr`);
  openssl('x509', '-req', '-in', `${name}-int.csr`, '-CA', `${name}-root.pem`, '-CAkey', `${name}-root.key`, '-set_serial', '2', '-days', '2', '-sha256', '-extfile', 'ca.ext', '-out', `${name}-int.pem`);
  openssl('req', '-new', '-config', 'min.cnf', '-key', `${name}-leaf.key`, '-subj', '/CN=127.0.0.1', '-out', `${name}-leaf.csr`);
  openssl('x509', '-req', '-in', `${name}-leaf.csr`, '-CA', `${name}-int.pem`, '-CAkey', `${name}-int.key`, '-set_serial', '3', '-days', '2', '-sha256', '-extfile', `${name}-leaf.ext`, '-out', `${name}-leaf.pem`);
  const read = (f: string) => readFileSync(join(dir, f), 'utf8');
  return { root: read(`${name}-root.pem`), leaf: read(`${name}-leaf.pem`), leafKey: read(`${name}-leaf.key`) };
}

async function listen(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return (server.address() as AddressInfo).port;
}

/** Serveur HTTPS qui n'envoie que son propre certificat (sans intermédiaire). */
async function httpsServer(cert: string, keyPem: string): Promise<string> {
  const port = await listen(
    createHttpsServer({ cert, key: keyPem }, (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    }),
  );
  return `https://127.0.0.1:${port}/v1/models`;
}

let trustedUrl = '';
let untrustedUrl = '';
let selfSignedUrl = '';

beforeAll(async () => {
  if (!OPENSSL) return;
  const aiaPort = await listen(
    createHttpServer((req, res) => {
      aiaHits.push(req.url ?? '');
      const name = /^\/(\w+)-int\.cer$/.exec(req.url ?? '')?.[1];
      if (!name) return res.writeHead(404).end();
      res.writeHead(200, { 'content-type': 'application/pkix-cert' });
      res.end(new X509Certificate(readFileSync(join(dir, `${name}-int.pem`))).raw);
    }),
  );
  const a = pki('A', `http://127.0.0.1:${aiaPort}/A-int.cer`);
  const b = pki('B', `http://127.0.0.1:${aiaPort}/B-int.cer`);
  // Seule la racine A est reconnue par ce poste ; la racine B ne l'est pas.
  tls.setDefaultCACertificates([...tls.getCACertificates('default'), a.root]);
  trustedUrl = await httpsServer(a.leaf, a.leafKey);
  untrustedUrl = await httpsServer(b.leaf, b.leafKey);
  key('self');
  openssl('req', '-x509', '-new', '-config', 'min.cnf', '-key', 'self.key', '-subj', '/CN=127.0.0.1', '-days', '2', '-addext', 'subjectAltName=IP:127.0.0.1', '-out', 'self.pem');
  selfSignedUrl = await httpsServer(readFileSync(join(dir, 'self.pem'), 'utf8'), readFileSync(join(dir, 'self.key'), 'utf8'));
}, 60_000);

afterAll(async () => {
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  rmSync(dir, { recursive: true, force: true });
});

const request = (url: string) => new HttpClient(silentLogger).json<{ ok: boolean }>(url, { signal: new AbortController().signal, connectTimeoutMs: 20_000 });

describe.skipIf(!OPENSSL)('certificats TLS des fournisseurs', () => {
  it('reproduit l’erreur de Node : serveur sans son certificat intermédiaire', async () => {
    const error = await fetch(trustedUrl).catch((e: unknown) => e);
    expect((error as { cause?: { code?: string } }).cause?.code).toBe('UNABLE_TO_VERIFY_LEAF_SIGNATURE');
  });

  it('ne fait jamais confiance à un intermédiaire téléchargé qui ne mène pas à une autorité reconnue', async () => {
    const before = tls.getCACertificates('default').length;
    const error = await request(untrustedUrl).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).message).toMatch(/chaîne complète/);
    expect((error as ProviderError).retryable).toBe(false);
    expect(aiaHits).toContain('/B-int.cer');
    expect(tls.getCACertificates('default').length).toBe(before);
  });

  it('complète la chaîne via AIA quand elle mène à une autorité reconnue, comme un navigateur', async () => {
    await expect(request(trustedUrl)).resolves.toEqual({ ok: true });
    expect(aiaHits.filter((u) => u === '/A-int.cer')).toHaveLength(1);
    // L'intermédiaire vérifié reste connu : les requêtes suivantes passent directement.
    await expect(request(trustedUrl)).resolves.toEqual({ ok: true });
    expect((await fetch(trustedUrl)).ok).toBe(true);
    expect(aiaHits.filter((u) => u === '/A-int.cer')).toHaveLength(1);
  });

  it('explique un certificat auto-signé sans rien télécharger', async () => {
    const hits = aiaHits.length;
    const error = await request(selfSignedUrl).catch((e: unknown) => e);
    expect((error as ProviderError).message).toMatch(/auto-signé/);
    expect(aiaHits.length).toBe(hits);
  });
});

describe('magasin de certificats du système', () => {
  it('s’ajoute une seule fois aux autorités de Node', () => {
    const first = trustSystemCertificates();
    expect(first).toBeGreaterThanOrEqual(0);
    expect(trustSystemCertificates()).toBe(first);
  });
});
