<p align="center">
  <img src="resources/branding/desktop.png" alt="Logo Monolith Harness" width="96">
</p>

<h1 align="center">Monolith Harness v3</h1>

<p align="center"><strong>Espace de travail IA portable — interface desktop, interface terminal et serveur optionnel.</strong></p>

> **Statut : réécriture en cours (3.0.0-alpha).** La v3 reconstruit Monolith Harness en TypeScript (Electron + Vue 3 + PrimeVue, moteur partagé, SQLite intégré). L'état exact de chaque fonctionnalité est tenu dans la [matrice des fonctionnalités](docs/FEATURE-MATRIX.md) : rien n'y est marqué réalisé sans traitement réel.

- **Local d'abord** : aucun compte, aucun abonnement, aucune télémétrie. Seuls les fournisseurs que vous configurez sont contactés, et chaque appel réseau est journalisé (hôte, chemin, statut, durée).
- **Portable** : les données vivent à côté de l'exécutable lorsque le dossier est inscriptible ; un emplacement alternatif est configurable.
- **Un seul moteur** : le desktop, le CLI (et bientôt le serveur) appliquent les mêmes règles, codées une seule fois dans `packages/core`.

## Disponible dans cette version

| Domaine | Fonctionnalités |
| --- | --- |
| Projets | Création, modification (nom, icône, couleur, instructions), plusieurs dossiers sources, réorganisation, suppression avec choix pour les conversations |
| Conversations | Espace personnel, renommage, favoris, épinglage, archivage, déplacement, réorganisation, recherche plein texte, brouillons par conversation, générations simultanées |
| Chat | Streaming robuste, arrêt, instantané de configuration par génération, Markdown, code coloré, réflexion (Aucun / Réduit / Détaillé), compteurs exacts ou estimés, débit |
| Fournisseurs | OpenAI, DeepSeek, OpenRouter, Google AI Studio (compatibilité OpenAI), Groq, Mistral, NVIDIA, Z.ai, Ollama, LM Studio, llama.cpp, tout serveur compatible OpenAI ; clés chiffrées, test, catalogue, sélection des modèles |
| Fiabilité | Nouvelles tentatives ciblées (transitoires, « 400 JSON tronqué »), reprise de l'état après fermeture |
| Apparence | Clair / sombre / système, thèmes Monolith, Fluent sombre V2, Graphite, accent, polices, densité, zoom |
| CLI | Conversations en streaming, éditeur multiligne, historique, autocomplétion, thèmes dont CRT, mode non interactif `-p` |

Le reste du périmètre (outils de l'agent, autorisations, MCP, mémoire, RAG, sous-agents, panneaux, outils dédiés, serveur…) est planifié par tranches : voir l'[ordre d'implémentation](docs/ROADMAP.md).

## Démarrer depuis les sources

Prérequis : **Node.js 24** et npm.

```bash
npm install
```

```bash
npm run dev
```

L'application de développement range ses données dans `.data/desktop` (ignoré par Git). Pour essayer sans fournisseur réel ni coût :

```bash
npm run mock
```

Puis, dans un autre terminal, créez un profil de démonstration et lancez le CLI dessus :

```bash
npm run demo:seed
```

```bash
npm run cli -- --data-dir .data/demo
```

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — processus, moteur partagé, stockage, secrets, transports.
- [Matrice des fonctionnalités](docs/FEATURE-MATRIX.md) — état par plateforme (desktop, CLI, serveur).
- [Ordre d'implémentation](docs/ROADMAP.md) — tranches successives.
- [Développement](docs/DEVELOPMENT.md) — scripts, tests, builds, distribution.
- [Inventaire de la v1](docs/V1-INVENTORY.md) — fonctionnalités et divergences relevées.
- [Licences des dépendances](docs/LICENSES.md).

## Licence

MIT — voir [LICENSE](LICENSE). Les composants tiers et leurs licences sont listés dans [THIRD-PARTY-LICENSES.txt](THIRD-PARTY-LICENSES.txt).
