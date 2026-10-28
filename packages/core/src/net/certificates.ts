import { X509Certificate } from 'node:crypto';
import { isIP } from 'node:net';
import * as tls from 'node:tls';

/**
 * Certificats TLS : Node vérifie les serveurs avec ses propres autorités (liste Mozilla intégrée), sans
 * le magasin du système ni le téléchargement des intermédiaires manquants que font les navigateurs et
 * .NET (v1). Ce module comble ces deux écarts sans jamais désactiver la vérification.
 */

/** Émetteur du certificat présenté introuvable : chaîne incomplète ou autorité inconnue de Node. */
const MISSING_ISSUER = new Set(['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_GET_ISSUER_CERT']);
const MAX_DOWNLOADS = 3;
const MAX_CERT_BYTES = 64 * 1024;
const RETRY_AFTER_FAILURE_MS = 5 * 60_000;

let systemTrusted: number | null = null;

/**
 * Ajoute les autorités du magasin du système (racines et intermédiaires de Windows, trousseau macOS,
 * magasin OpenSSL Linux) aux autorités par défaut de Node : autorités d'entreprise, antivirus qui
 * inspectent HTTPS, certificats installés par l'utilisateur. Idempotent ; renvoie le nombre ajouté.
 */
export function trustSystemCertificates(): number {
  if (systemTrusted !== null) return systemTrusted;
  systemTrusted = 0;
  if (typeof tls.getCACertificates !== 'function' || typeof tls.setDefaultCACertificates !== 'function') return 0;
  try {
    const current = tls.getCACertificates('default');
    const known = new Set(current.map(normalizePem));
    const added = tls.getCACertificates('system').filter((pem) => !known.has(normalizePem(pem)));
    if (added.length) tls.setDefaultCACertificates([...current, ...added]);
    systemTrusted = added.length;
  } catch {
    /* magasin du système illisible : les autorités intégrées restent seules */
  }
  return systemTrusted;
}

/** Code OpenSSL d'une erreur de fetch/TLS (`error.cause.code`), s'il y en a un. */
export function tlsErrorCode(error: unknown): string | null {
  let e = error as { code?: unknown; cause?: unknown } | undefined;
  for (let depth = 0; e && depth < 4; depth++) {
    if (typeof e.code === 'string' && (/CERT|SIGNATURE|SELF_SIGNED|ALTNAME/.test(e.code))) return e.code;
    e = e.cause as typeof e;
  }
  return null;
}

/** Explication lisible d'une erreur de certificat, avec la marche à suivre. */
export function describeTlsError(code: string): string | null {
  if (MISSING_ISSUER.has(code)) {
    return `certificat du serveur non vérifiable (${code}) : le serveur n'envoie pas sa chaîne complète (certificat intermédiaire manquant) ou il est signé par une autorité inconnue de ce poste. Configurez le serveur avec la chaîne complète (ex. fullchain.pem), ou installez son autorité dans le magasin de certificats du système.`;
  }
  if (code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || code === 'SELF_SIGNED_CERT_IN_CHAIN') {
    return `certificat auto-signé (${code}) : installez ce certificat ou son autorité dans le magasin de certificats du système (autorités de certification racines de confiance).`;
  }
  if (code === 'CERT_HAS_EXPIRED') return `certificat du serveur expiré (${code}).`;
  if (code === 'CERT_NOT_YET_VALID') return `certificat du serveur pas encore valide (${code}) : vérifiez l'horloge de ce poste.`;
  if (code === 'ERR_TLS_CERT_ALTNAME_INVALID') return `le certificat ne correspond pas au nom du serveur (${code}).`;
  return null;
}

/** Une chaîne incomplète peut-elle être complétée ? (émetteur manquant uniquement) */
export function isMissingIssuer(code: string | null): boolean {
  return code !== null && MISSING_ISSUER.has(code);
}

const attempts = new Map<string, { at: number; result: Promise<boolean> }>();

/**
 * Complète la chaîne d'un serveur qui n'envoie pas ses intermédiaires, comme un navigateur : lit les
 * certificats présentés, télécharge les émetteurs manquants indiqués par le certificat (AIA « CA Issuers »),
 * vérifie chaque signature, et n'ajoute ces intermédiaires aux autorités de Node que si la chaîne aboutit
 * à une autorité déjà reconnue. Rien n'est ajouté sinon. Renvoie vrai si une nouvelle tentative a un sens.
 */
export function completeCertificateChain(url: string, signal?: AbortSignal): Promise<boolean> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return Promise.resolve(false);
  }
  if (target.protocol !== 'https:' || typeof tls.setDefaultCACertificates !== 'function') return Promise.resolve(false);
  const key = target.host;
  const previous = attempts.get(key);
  if (previous && Date.now() - previous.at < RETRY_AFTER_FAILURE_MS) return previous.result;
  const result = complete(target, signal).catch(() => false);
  attempts.set(key, { at: Date.now(), result });
  return result;
}

async function complete(target: URL, signal?: AbortSignal): Promise<boolean> {
  const presented = await peerChain(target, signal);
  const trusted = tls.getCACertificates('default').map((pem) => new X509Certificate(pem));
  const found: X509Certificate[] = [];
  let current = presented[0];
  for (let i = 0; current && i < presented.length + MAX_DOWNLOADS; i++) {
    if (issuedBy(current, trusted)) break;
    const next = issuedBy(current, presented) ?? (found.length < MAX_DOWNLOADS ? await downloadIssuer(current, signal) : null);
    if (!next || next.fingerprint256 === current.fingerprint256) return false;
    if (!presented.includes(next)) found.push(next);
    current = next;
  }
  if (!current || !issuedBy(current, trusted) || !found.length) return false;
  const known = new Set(tls.getCACertificates('default').map(normalizePem));
  const add = found.map((c) => c.toString()).filter((pem) => !known.has(normalizePem(pem)));
  if (add.length) tls.setDefaultCACertificates([...tls.getCACertificates('default'), ...add]);
  return true;
}

/** Certificats envoyés par le serveur (feuille d'abord) : poignée de main seule, aucune donnée échangée. */
function peerChain(target: URL, signal?: AbortSignal): Promise<X509Certificate[]> {
  const host = target.hostname.replace(/^\[|\]$/g, '');
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port: Number(target.port) || 443, ...(isIP(host) ? {} : { servername: host }), rejectUnauthorized: false, timeout: 10_000 });
    const fail = (error: unknown) => {
      socket.destroy();
      reject(error);
    };
    signal?.addEventListener('abort', () => fail(signal.reason), { once: true });
    socket.once('timeout', () => fail(new Error('TLS timeout')));
    socket.once('error', fail);
    socket.once('secureConnect', () => {
      const chain: X509Certificate[] = [];
      let cert: tls.DetailedPeerCertificate | undefined = socket.getPeerCertificate(true);
      while (cert?.raw && chain.length < 10) {
        const x = new X509Certificate(cert.raw);
        if (chain.some((c) => c.fingerprint256 === x.fingerprint256)) break;
        chain.push(x);
        cert = cert.issuerCertificate;
      }
      socket.destroy();
      resolve(chain);
    });
  });
}

/** Émetteur de `cert` parmi `candidates`, signature vérifiée et période de validité en cours. */
function issuedBy(cert: X509Certificate, candidates: X509Certificate[]): X509Certificate | null {
  const now = Date.now();
  for (const c of candidates) {
    if (c.subject !== cert.issuer || !cert.checkIssued(c)) continue;
    if (Date.parse(c.validFrom) > now || Date.parse(c.validTo) < now) continue;
    try {
      if (cert.verify(c.publicKey)) return c;
    } catch {
      /* clé incompatible */
    }
  }
  return null;
}

/** Télécharge l'émetteur indiqué par l'extension AIA du certificat (DER ou PEM, taille bornée). */
async function downloadIssuer(cert: X509Certificate, signal?: AbortSignal): Promise<X509Certificate | null> {
  const urls = (cert.infoAccess ?? '')
    .split('\n')
    .map((line) => /^CA Issuers - URI:(https?:\/\/\S+)$/.exec(line.trim())?.[1])
    .filter((u): u is string => !!u);
  for (const url of urls) {
    try {
      const r = await fetch(url, { redirect: 'follow', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000) });
      if (!r.ok) continue;
      const bytes = Buffer.from(await r.arrayBuffer());
      if (bytes.length > MAX_CERT_BYTES) continue;
      const candidate = new X509Certificate(bytes);
      if (candidate.ca && issuedBy(cert, [candidate])) return candidate;
    } catch {
      /* adresse injoignable ou format non pris en charge (PKCS#7) : essayer la suivante */
    }
  }
  return null;
}

function normalizePem(pem: string): string {
  return pem.replace(/\s+/g, '');
}
