# Architecture — Monolith Harness v3 (réécriture)

> Statut : document de référence de la réécriture. Il décrit l'architecture **cible** ; l'état réel de chaque fonctionnalité est tenu dans [FEATURE-MATRIX.md](FEATURE-MATRIX.md).

## 1. Principes

| Principe | Traduction technique |
| --- | --- |
| Un seul moteur | Toute règle métier (autorisations, modes, instantanés de génération, retry, contexte) vit dans `packages/core`. Desktop, CLI et serveur n'en sont que des hôtes. |
| Local d'abord | Aucun compte, aucun serveur, aucune télémétrie. Seuls les fournisseurs et services choisis par l'utilisateur sont contactés, via un client HTTP unique qui journalise la destination (`network-log`). |
| Portable | Les données vivent à côté de l'exécutable si le dossier est inscriptible ; sinon emplacement configurable ; sinon dossier utilisateur du système. |
| Aucun module natif obligatoire | SQLite via `node:sqlite` (intégré à Node 24 / Electron 44, FTS5 disponible). Les capacités natives optionnelles (PTY, UI Automation) sont des **adaptateurs** déclarés, jamais des prérequis. |
| Capacités déclarées | Chaque outil publie sa disponibilité réelle par plateforme et par hôte (`desktop`, `cli`, `server`). Une capacité absente est retirée du modèle **et** expliquée à l'utilisateur. |
| Effets contrôlés par le moteur | Les modes (Plan / Proposition / Exécution) et les autorisations sont appliqués avant tout effet, quel que soit le modèle ou l'interface. |
| Repos réellement au repos | Pas de polling : événements, minuteries calées sur la prochaine échéance, animations suspendues hors focus/minimisé. |

## 2. Dépôt

```text
MonolithHarnessV2/
├─ packages/
│  ├─ contracts/        # Types, contrat d'API (méthodes + événements), codes d'erreur, i18n des messages moteur.
│  │                    # Sans dépendance Node : importable par le renderer et l'admin web.
│  └─ core/             # Moteur Node : stockage, services, fournisseurs, génération, outils, autorisations, plateforme.
├─ apps/
│  ├─ desktop/          # Electron : main (fenêtres, hôte natif), engine (utilityProcess), preload, renderer Vue 3 + PrimeVue 4.5
│  ├─ cli/              # Interface terminal interactive (même moteur, en processus)
│  └─ server/           # Serveur optionnel : API HTTP + WebSocket + admin web
├─ docs/                # Architecture, matrice, inventaire v1, guides
├─ scripts/             # Version, licences, empreintes, préparation de release
└─ .github/workflows/   # CI (build + tests) ; release en brouillon déclenchée manuellement
```

TypeScript strict partout. Les paquets internes sont consommés **en source** (exports `./src/index.ts`) et regroupés par les bundlers de chaque application (electron-vite pour le desktop, esbuild pour CLI et serveur).

## 3. Modèle de processus desktop

```text
┌──────────────┐  ipc (hôte)    ┌────────────────────────┐
│  Renderer    │◄──────────────►│  Main (Electron)       │
│  Vue 3       │                │  fenêtres, barre titre,│
│  sandbox:true│                │  dialogues, navigateur │
│  sans Node   │                │  intégré, captures,    │
└──────┬───────┘                │  contrôle desktop      │
       │ MessagePort direct     └──────────┬─────────────┘
       │ (RPC + événements)                │ parentPort (requêtes hôte)
┌──────▼───────────────────────────────────▼─────────────┐
│  Engine (utilityProcess, Node 24)                       │
│  @monolith/core : SQLite, génération, outils, MCP, RAG… │
└─────────────────────────────────────────────────────────┘
```

* **Main** reste léger : il ne fait jamais de SQL ni de streaming. Il crée la fenêtre, le moteur, et relie un `MessageChannelMain` entre renderer et moteur.
* **Engine** exécute `@monolith/core`. Un blocage (gros calcul, SQL) n'affecte ni la fenêtre ni l'interface. Il redémarre proprement s'il plante (les générations en cours passent en état « interrompu »).
* **Renderer** : `contextIsolation`, `sandbox`, pas de `nodeIntegration`, CSP stricte. Le preload n'expose que `invoke(method, params)`, `subscribe(event)` et quelques appels hôte nommés.
* **Aperçus interactifs** (HTML produit par l'IA) : `iframe sandbox="allow-scripts"` servie depuis un protocole dédié `mh-preview://` sans preload, sans cookies, CSP sans réseau par défaut. Aucun accès aux fichiers, clés ou IPC.
* **Navigateur intégré** : `WebContentsView` par onglet, partition persistante dédiée (`persist:browser`), suspendue lorsqu'elle est masquée.

Le CLI exécute le moteur **dans le même processus** (pas de fenêtre à protéger). Le serveur l'exécute dans son processus et l'expose via HTTP/WebSocket.

## 4. Contrat moteur ↔ interfaces

`packages/contracts` définit :

* `HarnessApi` : table `méthode → (paramètres) => résultat`. Exemple : `conversations.create`, `chat.send`, `providers.test`.
* `HarnessEvents` : événements typés poussés par le moteur (`conversation.updated`, `generation.delta`, `generation.finished`, `permission.requested`…).
* `HarnessError` : erreurs sérialisables avec code stable et message localisable.

Trois transports implémentent le même contrat : en processus (CLI, tests), `MessagePort` (desktop), HTTP + WebSocket (serveur). Les deltas de streaming sont **regroupés** (fenêtre ~32 ms) avant envoi pour limiter les réveils d'IPC et de rendu.

## 5. Stockage

* **Emplacement** (`core/platform/paths.ts`) : ordre de résolution
  1. `--data-dir` / `MONOLITH_DATA_DIR` ;
  2. fichier `monolith.location.json` à côté de l'exécutable (emplacement alternatif choisi dans Réglages) ;
  3. dossier `data/` à côté de l'exécutable s'il est inscriptible (portable) ;
  4. dossier utilisateur du système (`%APPDATA%/MonolithHarness`, `~/.local/share/monolith-harness`, `~/Library/Application Support/MonolithHarness`).
* **Arborescence** :

```text
data/
  monolith.sqlite            # base principale (WAL)
  keys/master.key.wrapped    # clé maître chiffrée par le système
  workspace/
    conversations/<id>/      # espace privé des conversations sans dossier
    attachments/<sha256>     # pièces jointes dédupliquées
    skills/                  # SKILL.md globaux
    assets/<conversation>/   # scènes et exports du générateur d'assets
    models/                  # modèles locaux, embeddings
    sandboxes/<job>/
    logs/
    backups/                 # sauvegardes automatiques avant migration
```

* **SQLite** : `node:sqlite` (synchrone, dans le processus moteur). WAL, `foreign_keys=ON`, `busy_timeout`. Migrations numérotées, appliquées en transaction, **somme SHA-256 de chaque migration enregistrée** et vérifiée au démarrage ; sauvegarde (`VACUUM INTO`) avant toute migration. Une base plus récente que l'application est ouverte en lecture seule avec avertissement, jamais rétrogradée.
* **Pièces jointes** stockées en fichiers adressés par contenu ; la base ne garde que les métadonnées.

## 6. Secrets

* Une **clé maître** aléatoire (256 bits) chiffre les secrets en AES-256-GCM (`node:crypto`).
* La clé maître est protégée par le système : Windows **DPAPI** (portée utilisateur), macOS **Trousseau**, Linux **libsecret** (`secret-tool`). Si aucun mécanisme n'est disponible (Linux sans trousseau), l'utilisateur est averti et peut choisir un fichier protégé par permissions `0600` — ce repli est affiché comme tel.
* Les secrets ne quittent jamais le moteur sauf vers le fournisseur concerné. L'interface ne reçoit qu'un indicateur « clé enregistrée » et les 4 derniers caractères.
* Un **expurgeur** central masque clés, jetons et en-têtes `Authorization` dans les logs, diagnostics et exports.

## 7. Fournisseurs et génération

```text
ProviderAdapter
  ├─ capabilities(model) → raisonnement, outils, images, contexte, sortie
  ├─ listModels()
  └─ stream(request, signal) → AsyncIterable<StreamEvent>
        StreamEvent = text | reasoning | toolCallDelta | usage | finish | error
```

Adaptateurs : OpenAI-compatible (base de OpenRouter, Groq, Mistral, NVIDIA, Z.ai, DeepSeek, modèles locaux llama.cpp), Gemini (AI Studio), Vertex AI (ADC/OAuth/clé, Express), OpenCode, ACP (agents externes), composite (orchestrateur + spécialistes).

**GenerationRunner** :

1. Fige un **instantané** (fournisseur, modèle, réflexion, mode, ressources, skills, autorisations) au démarrage ; aucune modification ultérieure ne l'affecte.
2. Construit l'historique pour le protocole cible (reconstruction après changement de fournisseur : signatures de raisonnement et blocs propriétaires retirés si non compatibles).
3. Diffuse les événements normalisés ; un parseur SSE tolérant gère fragments, lignes partielles, `[DONE]`, keep-alive.
4. Boucle d'outils : appel → autorisation → exécution → résultat fidèle ; les instructions transmises pendant la génération sont injectées **entre deux tours** (frontière contrôlée).
5. Retry : uniquement pour réseau, 408, 429, 5xx et le cas ciblé « 400 JSON tronqué par une passerelle » ; jamais après qu'un outil a été exécuté dans le tour en cours.
6. Annulation : arbre d'`AbortController` (génération → sous-agents → outils).

Chaque appel IA (chat, nommage, mémoire, vision, sous-agent, benchmark…) écrit une ligne dans le **registre de consommation** avec indication exacte/estimée.

## 8. Outils, modes et autorisations

* **ToolRegistry** : chaque outil déclare `family`, `effects` (`read`, `write`, `exec`, `network`, `desktop`), plateformes et hôtes supportés.
* **Modes** : Chat (pas d'outils sauf skills conversationnels activés) ; Agent-Plan (effets `read` uniquement) ; Agent-Proposition (écritures transformées en propositions consultables) ; Agent-Exécution (selon politique). Filtrage **avant** exposition au modèle **et** revérification avant exécution.
* **PermissionEngine** : politique globale (Refuser tout / Demander / Règles), règles par outil, famille, ressource (glob de chemin, hôte réseau) et projet ; priorité : refus explicite > règle la plus spécifique > politique par défaut. Chaque décision est historisée et rattachée à l'appel (bouclier dans la bulle).
* **Ressources** : une conversation n'accède qu'à ses racines autorisées (dossiers du projet, dossiers/fichiers propres, espace privé). Les chemins sont canonisés (`realpath`) pour neutraliser `..` et liens symboliques.
* **Sandbox** optionnelle : copie des ressources autorisées dans `workspace/sandboxes/<job>`, diff et application sélective.

## 9. Plateformes

`core/platform/capabilities.ts` déclare, par OS et par hôte, ce qui est **implémenté**, **planifié** ou **indisponible** (avec raison). macOS figure dans la table avec l'état réel ; aucune capacité n'est annoncée sans implémentation.

## 10. Interface desktop

* Vue 3 + PrimeVue 4.5 (MIT) en mode « styled » avec preset maison dérivé d'Aura ; jetons CSS (`--mh-*`) pour les thèmes (clair, sombre, Fluent sombre V2, palettes personnalisées).
* État : stores réactifs Vue (`reactive` + composables), alimentés par les événements moteur ; aucune donnée dupliquée hors du cache d'affichage.
* Rendu des messages : Markdown incrémental (seul le dernier bloc en cours est re-rendu), coloration Shiki chargée à la demande, KaTeX, Mermaid à la demande, liste virtualisée pour les longues conversations.
* Barre de titre personnalisée (`titleBarStyle: hidden` + `titleBarOverlay` sous Windows pour garder les contrôles natifs fiables) avec repli système.

## 11. CLI

Interface terminal interactive (Ink) au-dessus du même moteur : éditeur multiligne, historique, autocomplétion, streaming interruptible, file d'attente, modes, autorisations interactives. Les outils graphiques sont retirés du modèle et expliqués. Toute sortie de contenu non fiable passe par un **assainisseur** qui neutralise les séquences de contrôle terminal.

## 12. Serveur

Processus Node autonome : API REST documentée (OpenAPI), WebSocket pour le temps réel, admin web (Vue + PrimeVue), comptes/rôles, clés côté serveur, exécution cloud dans des espaces de projet, planificateur, partage en direct relayé, journal d'audit. Installable comme service (systemd / service Windows).

## 13. Distribution

* electron-builder : Windows (portable + NSIS), Linux (AppImage, tar.gz, deb).
* CLI et serveur : bundles esbuild, puis exécutables autonomes Node SEA.
* Versions alignées (`scripts/sync-version.mjs`), changelog daté, `SHA256SUMS.txt`, inventaire des licences tierces (`scripts/collect-licenses.mjs`), releases GitHub en **brouillon** uniquement sur demande explicite.
