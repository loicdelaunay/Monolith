# CLI Monolith Harness — suite du développement reportée

Le développement du CLI (ancienne tranche **T12 — CLI complet**) est **reporté à plus tard**, à la demande de l'utilisateur (2026-10-27). Le CLI existant (`apps/cli`, 3.0.0-alpha) reste fonctionnel et partage le même moteur que le desktop ; rien de nouveau n'y est ajouté pour l'instant. Les cellules « CLI » de `docs/FEATURE-MATRIX.md` qui ne sont pas ✅ relèvent de ce document.

## Déjà disponible dans le CLI

- Interface Ink (React) interactive et mode non interactif `-p` (autorisations et questions refusées explicitement).
- Conversations : création, liste, ouverture, renommage, suppression, archivage, épinglage, favoris, recherche, export Markdown, reprise, bifurcation, objectif, compactage, contexte.
- Projets : liste, sélection, création, déplacement de conversation.
- Fournisseurs : liste et choix du modèle (`/model`), réflexion (`/reasoning`), modes (`/mode`), raccourcis (`/shortcut`, Alt+chiffre).
- File d'attente et pilotage (`/queue`, `/unqueue`, `/next`, `/steer`), pièces jointes (`/attach`, `/detach`), modèles de messages.
- Outils et autorisations : demandes au clavier, règles (`/rules`, `/allow`, `/deny`, `/unrule`), propositions (`/proposals`, `/apply`, `/reject`), ressources (`/resources`), détection de boucle.
- Connaissances : `/mcp` (état, connexion, activation par conversation), `/memory`, `/rag`.
- Orchestration : `/subagents` (liste), `/sandbox` (activation, diff, application, abandon).
- Thèmes de couleurs, changelog, informations.

## Reste à faire (parité et confort)

| Domaine | À développer |
| --- | --- |
| Projets | Renommer, supprimer, réordonner ; instructions de projet ; plusieurs dossiers ; import `permission.json`. |
| Fournisseurs | Création et configuration complètes depuis le CLI (assistant), test de connexion, import du catalogue, sélection des modèles, Gemini / Vertex / ACP / composés / modèles locaux. |
| Rendu | Mermaid (source ou rendu texte), LaTeX (rendu Unicode approché), badges de fichiers vérifiés, réglages de rendu. |
| Autorisations | Historique des décisions, détail du bouclier par appel, diff formaté plus riche. |
| Mémoire | Administration (édition, versions, portées), lecture/écriture forcées. |
| MCP | Ajout, import JSON prévisualisé, modification, secrets, suppression. |
| Sous-agents | Suivi en direct, ouverture d'un sous-agent, réglages (rôles, budgets), worktrees. |
| Outils dédiés | Traducteur/correcteur, benchmark, détection IA, génération d'images, assets (export). |
| Suivi | Tableau de bord (texte), diagnostics, tâches planifiées (création, historique), notifications. |
| Modèles locaux | Catalogue Hugging Face, téléchargements, moteur llama.cpp. |
| Réglages | Édition de toutes les sections (aujourd'hui via le desktop), réinitialisations ciblées. |
| Apparence | Thèmes rétro / CRT, sortie compacte, accessibilité (lecteurs d'écran, couleurs réduites). |
| Distribution | Exécutable autonome (Node SEA) Windows/Linux, mises à jour, complétion de shell, page de manuel. |
| Tests | Parcours CLI de bout en bout sur chaque commande, mode non interactif, terminaux Windows et Linux. |

## Principes à conserver

- Aucune règle métier dans le CLI : tout passe par le moteur (`packages/core`) et le contrat `HarnessApi`.
- Les textes affichés proviennent des catalogues FR/EN partagés (`packages/contracts/src/i18n`).
- Aucune publication distante sans demande explicite de l'utilisateur.
