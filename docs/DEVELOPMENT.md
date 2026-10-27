# Développement

## Prérequis

- Node.js **24** (le moteur utilise `node:sqlite`, intégré à Node 24 et à Electron 44).
- npm 11. Aucun compilateur natif n'est nécessaire : le projet n'a pas de module natif.

## Organisation

| Dossier | Rôle |
| --- | --- |
| `packages/contracts` | Types, contrat d'API (`HarnessApi`, `HarnessEvents`), erreurs, préréglages fournisseurs, i18n FR/EN, client RPC. Sans dépendance Node. |
| `packages/core` | Moteur : stockage SQLite et migrations, secrets, réglages, projets, conversations, fournisseurs, génération, journal. |
| `apps/desktop` | Electron : `src/main` (fenêtre, hôte natif), `src/engine` (moteur en `utilityProcess`), `src/preload` (pont sandboxé), `src/renderer` (Vue 3 + PrimeVue 4.5). |
| `apps/cli` | Interface terminal (Ink) sur le même moteur, en processus. |
| `scripts` | Version, licences, empreintes, faux fournisseur, profil de démonstration. |

Les paquets internes sont consommés en source TypeScript et regroupés par les bundlers ; il n'y a pas d'étape de compilation séparée.

## Scripts

| Commande | Effet |
| --- | --- |
| `npm run dev` | Desktop en développement (rechargement à chaud de l'interface), données dans `.data/desktop`. |
| `npm run cli -- [options]` | Construit puis lance le CLI (données par défaut : `.data/cli`). |
| `npm run typecheck` | Vérification TypeScript de tous les paquets (vue-tsc pour l'interface). |
| `npm test` | Tests unitaires, d'intégration et de parcours (Vitest). |
| `npm run build` | Bundles desktop (`apps/desktop/out`) et CLI (`apps/cli/dist/monolith.mjs`). |
| `npm run gui:build` | Build de test : un seul dossier `artifacts/GUI` avec `Monolith.exe`, données de test conservées. |
| `npm run dist:win` / `npm run dist:linux` | Paquets de distribution dans `release/` (zip portable + installateur NSIS / AppImage, tar.gz, deb). |
| `npm run quality` | Après `npm run build` : audit d'accessibilité axe-core (WCAG 2.1 A/AA) et mesures de performance sur la fenêtre réelle, profil de démonstration temporaire → `artifacts/quality/report.json`. `-- --strict` échoue sur une violation grave. |
| `npm run licenses` | Inventaire des licences embarquées → `THIRD-PARTY-LICENSES.txt`, `docs/LICENSES.md`. Échoue sur une licence non compatible. |
| `npm run version:sync -- <x.y.z>` | Aligne la version de GUI, CLI et moteur. |
| `npm run release:prepare -- <dossier>` | Vérifie l'absence de données utilisateur et écrit `SHA256SUMS.txt`. |
| `npm run mock` | Faux fournisseur compatible OpenAI sur `127.0.0.1:11500` (aucun coût, aucun réseau externe). |
| `npm run demo:seed` | Profil de démonstration `.data/demo` pointant vers le faux fournisseur. |

## Tests

- Les tests utilisent des **dossiers temporaires isolés** et un faux fournisseur HTTP local ; aucun appel à un fournisseur réel n'est fait.
- `packages/core/test` : parseur SSE fragmenté (y compris coupures UTF-8 et CRLF), classement des erreurs et retry, migrations et sommes de contrôle, sauvegarde avant migration, base plus récente ouverte en lecture seule, résolution du dossier de données, chiffrement des clés, génération de bout en bout, annulation sans nouvelle tentative, instantané figé, générations parallèles, reprise après arrêt.
- `apps/cli/test` : assainissement des séquences terminal, éditeur multiligne, historique, commandes, parcours interactif complet dans un faux terminal.
- `packages/contracts/test` : présence de chaque clé de traduction utilisée en français et en anglais.

### Tests visuels sur la fenêtre réelle

Le processus principal accepte, **uniquement via des variables d'environnement**, un mode de capture :

```bash
MONOLITH_DATA_DIR=.data/demo MONOLITH_SMOKE_SHOT=capture.png npx electron apps/desktop
```

`MONOLITH_SMOKE_STEPS` contient des scripts séparés par `|||`, exécutés dans l'interface avant chaque capture intermédiaire (`capture-1.png`, …). Les résultats sont affichés dans la console (`SMOKE n …`). `MONOLITH_SMOKE_INJECT` désigne un script injecté avant les étapes (axe-core pour `npm run quality`).

## Conventions

- TypeScript strict ; code et commentaires en français, identifiants en anglais.
- Toute règle métier vit dans `packages/core` ; les interfaces n'en dupliquent aucune.
- Une fonctionnalité n'est marquée ✅ dans la matrice qu'avec un traitement réel et une vérification (test ou parcours documenté).
- Nouvelle dépendance : vérifier sa licence (`npm run licenses`). PrimeVue reste en **4.5.x (MIT)**.
- Les actions principales des fenêtres sont en bas à droite ; l'action principale est accentuée.
- Aucune publication distante (push, tag, release) sans demande explicite. Les releases sont préparées en brouillon par le workflow manuel `Release (brouillon)`.

## Données de développement

`.data/` (ignoré par Git) contient les profils de développement : `desktop`, `cli`, `demo`, `smoke`. Ils peuvent être supprimés à tout moment. Les données de la v1 ne sont jamais lues ni modifiées.

## Distribution et mises à jour

1. `npm run dist:win` produit `release/MonolithHarness-vX-win-x64.zip` (portable : données dans `data/` à côté de `Monolith.exe`) et `release/MonolithHarness-vX-win-x64.exe` (installateur NSIS par utilisateur).
2. `npm run release:prepare -- <dossier>` refuse tout fichier ressemblant à des données utilisateur et écrit `SHA256SUMS.txt`.
3. La publication se fait uniquement par le workflow manuel « Release (brouillon) », qui crée au plus une release **en brouillon** ; la rendre publique reste une action manuelle.

Mises à jour intégrées (Réglages › À propos) : le moteur interroge les versions GitHub du dépôt `loicdelaunay/Monolith` et ne retient que les paquets `MonolithHarness-v*-win-x64.zip` dont GitHub publie l'empreinte (`digest`). Après téléchargement et vérification SHA-256, la base est sauvegardée, puis le processus principal lance l'installateur PowerShell (`apply-update.ps1`, dans `data/updates`) et se ferme. L'installateur revérifie l'empreinte, conserve `data/` et `monolith.location.json`, place l'ancienne version dans `data/updates/previous`, restaure en cas d'échec et écrit `update-result.json`, signalé au démarrage suivant.
