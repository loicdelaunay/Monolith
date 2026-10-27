# Ordre d'implémentation

Chaque tranche se termine par : compilation (`npm run typecheck`, `npm run build`), tests (`npm test`), mise à jour de [FEATURE-MATRIX.md](FEATURE-MATRIX.md) et, si visible pour l'utilisateur, une entrée du [CHANGELOG](../CHANGELOG.md). Le CLI suit chaque tranche puisqu'il partage le moteur.

État au 2026-10-27 : **T0 à T11 livrées** (3.0.0-alpha.11). Les éléments encore partiels de ces tranches sont détaillés dans la matrice (ex. PDF en pièce jointe, CLI sans édition de file).

| Tranche | Contenu | Dépend de |
| --- | --- | --- |
| **T0 — Fondations** | Monorepo TS, contrats d'API, chemins portables + emplacement alternatif, SQLite (`node:sqlite`) + migrations vérifiées + sauvegarde, secrets (clé maître protégée par le système), logs expurgés, i18n FR/EN, CI GitHub (build + tests, sans publication). | — |
| **T1 — Chat de bout en bout** | Projets (CRUD, ordre, icône/couleur, plusieurs dossiers), espace personnel, conversations (CRUD, recherche, favoris, épinglage, archivage, ordre, brouillons), fournisseurs OpenAI-compatibles/DeepSeek (liste/détail, clé masquée, test, catalogue, ajout manuel), streaming robuste, annulation, instantané de génération, retry ciblé, rendu Markdown/code, réglages Général/Chat/Apparence/Fournisseurs/À propos, thèmes (dont Fluent sombre V2), barre de titre, changelog intégré ; CLI : projets, conversations, chat en streaming interruptible. | T0 |
| **T2 — Conversation avancée** | File d'attente éditable, instruction pendant génération, bifurcation/duplication, « Reprendre ici », export Markdown, modèles de messages, objectif, nommage automatique, pièces jointes, capacités de réflexion + 3 niveaux d'affichage, contexte (compteurs, cache, compactage), registre de consommation. | T1 |
| **T3 — Outils et autorisations** | Registre d'outils, modes Agent Plan/Proposition/Exécution appliqués par le moteur, moteur d'autorisations + historique + bouclier, ressources de conversation et espace privé, outils sources/glob/grep/édition/patch, diff `edit_source`, terminaux asynchrones, questions interactives, propositions d'actions, détection de boucle. | T2 |
| **T4 — Panneaux de travail** | Panneau redimensionnable, fichiers + aperçu Raw/Preview, terminal (xterm), Git, navigateur intégré (onglets, DOM, captures, vue mobile), aperçus interactifs isolés, Mermaid, LaTeX. | T3 |
| **T5 — Fournisseurs étendus** | Gemini, Vertex AI (ADC/OAuth/clé/Express), préréglages OpenRouter/Groq/Mistral/NVIDIA/Z.ai, OpenCode, ACP, modèles composés, raccourcis fournisseur/modèle/mode/réflexion. | T2 |
| **T6 — Contexte durable** | Mémoire (portées, versions, vue admin, options forcées), index `index.ohm`, RAG local/distant, skills `SKILL.md`, MCP (stdio/HTTP, import JSON, `/mcp`), recherche web + artefacts. | T3 |
| **T7 — Orchestration** | Sous-agents (budgets, profondeur, parallélisme, préréglages), worktrees Git, sandbox avec diff et application sélective. | T3, T6 |
| **T8 — Outils dédiés** | Traducteur/correcteur, générateur d'assets, benchmark, détection de contenu IA, génération d'images, vision. | T5 |
| **T9 — Exploitation** | Dashboard de consommation, diagnostics, tâches planifiées, notifications, animations de fond, réglages Avancé (GPU, backend, rafraîchissement), réinitialisations ciblées. | T2 |
| **T10 — Modèles locaux** | GGUF, catalogue Hugging Face, téléchargements vérifiés, llama.cpp, CPU/GPU, estimation RAM/VRAM. | T5 |
| **T11 — Contrôle desktop** | Windows UI Automation / API / Legacy séparés souris/clavier, capacités Linux/macOS déclarées. | T4 |
| **T12 — CLI complet** (reporté) | Reporté à plus tard à la demande de l’utilisateur : périmètre restant dans `cli-todo.md`. | T7 |
| **T13 — Serveur** (reporté) | Reporté à plus tard à la demande de l’utilisateur : périmètre détaillé dans `server-todo.md`. | T7 |
| **T14 — Distribution** | Paquets Windows/Linux, SEA CLI/serveur, mises à jour vérifiées, SHA-256, licences, tests visuels/accessibilité/performance. | toutes |
