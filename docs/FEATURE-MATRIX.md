# Matrice des fonctionnalités et suivi

Légende : ✅ réalisé et vérifié · 🟡 partiel (détail en note) · ⬜ restant · ⛔ bloqué (raison) · ➖ non applicable à cette plateforme (raison).
Colonnes : **D** desktop (Windows/Linux), **C** CLI, **S** serveur. **T** = tranche prévue ([ROADMAP](ROADMAP.md)). macOS : voir §16.

Un ✅ signifie que l'action est réellement exécutée par le moteur et couverte par un test ou une vérification manuelle documentée ; jamais une interface sans traitement.

**Dernière mise à jour : 2026-10-27, fin de la tranche T1 (3.0.0-alpha.1).**

## 1. Fondations

| ID | Fonctionnalité | D | C | S | T | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| F-01 | Monorepo TypeScript, moteur partagé | ✅ | ✅ | ⬜ | T0 | Moteur partagé testé ; serveur en T13. |
| F-02 | Données portables à côté de l'exécutable si inscriptible | ✅ | ✅ | ⬜ | T0 | Vérifié sur le build Windows empaqueté (dossier `data/` créé à côté de l’exe). Installation NSIS → dossier utilisateur. |
| F-03 | Emplacement de données alternatif configurable | ✅ | 🟡 | ⬜ | T0 | Desktop : Réglages › Général (effet au redémarrage, rien n’est déplacé). CLI : `--data-dir` seulement. |
| F-04 | SQLite versionnée, migrations vérifiées (SHA-256), sauvegarde avant migration | ✅ | ✅ | ⬜ | T0 | Sommes SHA-256 vérifiées, `VACUUM INTO` avant migration, base plus récente en lecture seule (tests). |
| F-05 | Sauvegarde / restauration manuelles | ⬜ | ⬜ | ⬜ | T9 | |
| F-06 | Secrets chiffrés (clé maître protégée DPAPI / Trousseau / libsecret) | ✅ | ✅ | ⬜ | T0 | DPAPI vérifié réellement (aller-retour) ; libsecret implémenté, non testé sur Linux ; Trousseau macOS non vérifié. |
| F-07 | Logs expurgés des secrets, niveaux, rétention | 🟡 | 🟡 | ⬜ | T0 | Journal JSONL expurgé, rétention 14 j ; réglage du niveau et de la durée : T9. |
| F-08 | Journal des appels réseau identifiables | 🟡 | 🟡 | ⬜ | T1 | Chaque appel journalisé (hôte, chemin, statut, durée) ; consultation dans Diagnostics : T9. |
| F-09 | i18n FR / EN | 🟡 | 🟡 | ⬜ | T0 | Interface FR/EN complète (test de couverture des clés) ; détails d’erreur du moteur encore en français. |
| F-10 | Aucune télémétrie, aucun compte requis en local | ✅ | ✅ | ➖ | T0 | Le serveur gère ses propres comptes. |

## 2. Projets et ressources

| ID | Fonctionnalité | D | C | S | T | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| P-01 | Créer, renommer, supprimer, réordonner | ✅ | 🟡 | ⬜ | T1 | CLI : création et sélection ; renommage/suppression de projet en T12. |
| P-02 | Espace personnel (conversations sans projet) | ✅ | ✅ | ⬜ | T1 | |
| P-03 | Icône et couleur | ✅ | ➖ | ⬜ | T1 | CLI : couleur affichée si le terminal la supporte. |
| P-04 | Plusieurs dossiers sources par projet | ✅ | 🟡 | ⬜ | T1 | Ajout/retrait, disponibilité vérifiée ; accès des outils aux dossiers en T3. CLI : affichage. |
| P-05 | Ressources propres à une conversation (fichiers, dossiers, héritage) + retour aux valeurs du projet | ⬜ | ⬜ | ⬜ | T3 | |
| P-06 | Fichier attaché = accès à ce seul fichier | ⬜ | ⬜ | ⬜ | T3 | |
| P-07 | Espace privé persistant pour conversation sans dossier | ⬜ | ⬜ | ⬜ | T3 | |
| P-08 | Instructions de projet (menu contextuel + fenêtre) | ✅ | ⬜ | ⬜ | T1 | Menu contextuel et fenêtre ; appliquées aux prochains envois (testé côté moteur). |
| P-09 | Import + prévisualisation `permission.json` | ⬜ | ⬜ | ⬜ | T3 | |
| P-10 | Fichiers d'instructions du projet et sous-dossiers avec portée explicite | ⬜ | ⬜ | ⬜ | T3 | AGENTS.md, CLAUDE.md, .monolith/instructions.md |

## 3. Conversations

| ID | Fonctionnalité | D | C | S | T | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| C-01 | Plusieurs conversations et générations simultanées | ✅ | ✅ | ⬜ | T1 | Test : deux générations parallèles. |
| C-02 | Créer, renommer, rechercher, favoris, épingler, archiver, supprimer | ✅ | ✅ | ⬜ | T1 | Recherche FTS5 titres + messages. |
| C-03 | Réorganisation dans la barre latérale | ✅ | 🟡 | ➖ | T1 | Desktop : glisser-déposer (ordre et déplacement entre projets). CLI : `/move` entre projets. |
| C-04 | Brouillons par conversation | ✅ | ✅ | ➖ | T1 | |
| C-05 | Nommage automatique (fournisseur/modèle dédiés) | ⬜ | ⬜ | ⬜ | T2 | |
| C-06 | Objectif persistant | ⬜ | ⬜ | ⬜ | T2 | |
| C-07 | Modèles de messages | ⬜ | ⬜ | ⬜ | T2 | |
| C-08 | Export Markdown | ⬜ | ⬜ | ⬜ | T2 | |
| C-09 | Duplication / bifurcation depuis un message | ⬜ | ⬜ | ⬜ | T2 | |
| C-10 | « Reprendre ici » (texte + pièces jointes dans l'éditeur), historique précédent préservé | ⬜ | ⬜ | ⬜ | T2 | |
| C-11 | File d'attente : édition, suppression, réordonnancement | ⬜ | ⬜ | ⬜ | T2 | |
| C-12 | Instruction pendant génération, traitée à une frontière contrôlée | ⬜ | ⬜ | ⬜ | T2 | |
| C-13 | Annulation d'une génération et de ses travaux enfants | 🟡 | 🟡 | ⬜ | T1 | Annulation de la génération testée (contenu partiel conservé, aucune nouvelle tentative) ; travaux enfants : T7. |
| C-14 | Instantané de configuration par génération | ✅ | ✅ | ⬜ | T1 | Test : changement de modèle pendant la génération sans effet. |

## 4. Interface desktop

| ID | Fonctionnalité | D | C | S | T | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| U-01 | Barre latérale projets/conversations/recherche/notifications | 🟡 | ➖ | ➖ | T1 | Projets, conversations, recherche ; notifications en T9. |
| U-02 | Panneau d'outils redimensionnable (navigateur, terminaux, Git, fichiers, assets, aperçu) | ⬜ | ➖ | ➖ | T4 | |
| U-03 | Barre supérieure : identité unique, contrôles natifs uniques, repli système, drag jusqu'au bord | 🟡 | ➖ | ➖ | T1 | Identité unique, contrôles natifs superposés (un seul jeu), repli « cadre système », zone de déplacement jusqu’au bord. À vérifier manuellement : déplacement depuis une fenêtre maximisée. |
| U-04 | Bouton version → changelog intégré | ✅ | ✅ | ⬜ | T1 | CLI : `/changelog`. |
| U-05 | Menu outils dédiés en bas de la barre latérale, à côté de Réglages | ⬜ | ➖ | ➖ | T8 | |
| U-06 | Saisie multiligne, Entrée/Maj+Entrée, collage, glisser-déposer | 🟡 | 🟡 | ➖ | T1 | Texte multiligne, Entrée / Maj+Entrée, collage de texte ; pièces jointes et dépôt de fichiers en T2 (refus expliqué). |
| U-07 | Autocomplétion commandes et skills | ⬜ | ⬜ | ➖ | T2 | |
| U-08 | Agrandissement de la saisie au-delà de 10 lignes, retour sans perte | ✅ | ➖ | ➖ | T1 | |
| U-09 | Débit et utilisation du contexte (optionnels) | ⬜ | ⬜ | ➖ | T2 | |
| U-10 | Accessibilité : clavier, focus visible, libellés, texte agrandi, petites fenêtres | 🟡 | ➖ | ⬜ | T1→T14 | Navigation clavier, focus visible, libellés ARIA, mise en page étroite ; audit complet en T14. |

## 5. Chat, rendu et historique

| ID | Fonctionnalité | D | C | S | T | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| R-01 | Markdown, tableaux, listes, citations, liens | ✅ | 🟡 | ⬜ | T1 | CLI : rendu texte simplifié. |
| R-02 | Code coloré, copie, numéros de ligne | ✅ | 🟡 | ⬜ | T1 | Shiki chargé à la demande, copie, numéros de ligne (réglage). CLI : blocs colorés sans coloration syntaxique. |
| R-03 | Images et documents (limites explicites) | ⬜ | ⬜ | ⬜ | T2 | |
| R-04 | Mermaid | ⬜ | ➖ | ⬜ | T4 | CLI : source affichée. |
| R-05 | LaTeX en ligne et en bloc | ⬜ | ➖ | ⬜ | T4 | |
| R-06 | Cartes web et aperçus interactifs isolés | ⬜ | ➖ | ⬜ | T4 | |
| R-07 | Réglages indépendants par type de rendu | ⬜ | ⬜ | ➖ | T4 | |
| R-08 | Styles de réponse (défaut, court, pragmatique, détaillé, ludique) | ✅ | 🟡 | ⬜ | T1 | Appliqué par le moteur ; CLI : réglage partagé, pas de commande dédiée. |
| R-09 | Badges de fichiers vérifiés (existence, ligne, type) | ⬜ | ➖ | ⬜ | T4 | |
| R-10 | Réflexion : affichage Aucun / Réduit / Détaillé | ✅ | ✅ | ⬜ | T2 | Réglage distinct du niveau demandé. |
| R-11 | Chronologie réflexion/outils/réponses | 🟡 | 🟡 | ⬜ | T2 | Parties ordonnées à l’arrivée (réflexion/texte/notices) ; outils et questions en T3. |
| R-12 | Défilement : suivi auto, suspension, position conservée | 🟡 | ➖ | ➖ | T1 | Suivi, suspension (molette/clavier), reprise en bas, sans polling ; test automatisé à ajouter. |
| R-13 | Virtualisation des longues conversations | ⬜ | ➖ | ➖ | T2 | |

## 6. Fournisseurs et modèles

| ID | Fonctionnalité | D | C | S | T | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| M-01 | OpenAI-compatible | ✅ | ✅ | ⬜ | T1 | |
| M-02 | DeepSeek | ✅ | ✅ | ⬜ | T1 | `reasoning_content` et `prompt_cache_hit_tokens` pris en charge. |
| M-03 | Google AI Studio / Gemini | ⬜ | ⬜ | ⬜ | T5 | |
| M-04 | Vertex AI (ADC/OAuth, clé, Express) | ⬜ | ⬜ | ⬜ | T5 | |
| M-05 | OpenRouter, Z.ai, Groq, Mistral, NVIDIA | 🟡 | 🟡 | ⬜ | T5 | Préréglages compatibles OpenAI disponibles ; non vérifiés contre les services réels ; adaptateurs dédiés en T5. |
| M-06 | OpenCode | ⬜ | ⬜ | ⬜ | T5 | |
| M-07 | Agents externes ACP | ⬜ | ⬜ | ⬜ | T5 | |
| M-08 | Modèles locaux (GGUF, HF, llama.cpp) | ⬜ | ⬜ | ⬜ | T10 | |
| M-09 | Modèles composés (orchestrateur + spécialistes) | ⬜ | ⬜ | ⬜ | T5 | |
| M-10 | Connexions multiples indépendantes du même fournisseur | ✅ | ✅ | ⬜ | T1 | Duplication avec clé recopiée. |
| M-11 | Écran liste/détail, logos locaux, onglets Connexion/Modèles/Avancé | ✅ | ➖ | ⬜ | T1 | CLI : `/providers` (lecture seule). |
| M-12 | Clé masquée, remplacement explicite, validation non restrictive | ✅ | ✅ | ⬜ | T1 | Aucune règle de préfixe ; seuls espaces, contrôles et non-ASCII refusés. |
| M-13 | Test de connexion (résultat sous le bouton) | ✅ | ⬜ | ⬜ | T1 | Résultat sous le bouton ; test par génération seulement si autorisé. |
| M-14 | Import catalogue, recherche, sélection, pagination, ajout manuel | ✅ | ⬜ | ⬜ | T1 | |
| M-15 | Sélecteur fournisseur puis modèle dans le chat | ✅ | 🟡 | ➖ | T1 | CLI : `/model [connexion/]modèle`. |
| M-16 | Raccourcis fournisseur/modèle/mode/réflexion | ⬜ | ⬜ | ➖ | T5 | |
| M-17 | Génération d'images (locale ou distante) | ⬜ | ⬜ | ⬜ | T8 | |

## 7. Réflexion, contexte, fiabilité

| ID | Fonctionnalité | D | C | S | T | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Q-01 | Niveaux de réflexion déclarés uniquement, Auto si inconnu, interrupteur simple | ⬜ | ⬜ | ⬜ | T2 | |
| Q-02 | Niveau demandé / envoyé / paramètre / repli affichés | ⬜ | ⬜ | ⬜ | T2 | |
| Q-03 | « Sans réflexion » réel ou incompatibilité signalée | ⬜ | ⬜ | ⬜ | T2 | |
| Q-04 | Niveau rejeté retiré jusqu'à réévaluation | ⬜ | ⬜ | ⬜ | T2 | |
| Q-05 | Fenêtre de contexte / limite de sortie, auto ou personnalisée | ⬜ | ⬜ | ⬜ | T2 | |
| Q-06 | Compteurs API ou estimation signalée, tokens en cache | ✅ | ✅ | ⬜ | T1 | Compteurs API, cache, estimation signalée ; utilisation de la fenêtre de contexte en T2. |
| Q-07 | Compactage manuel/auto, historique original conservé | ⬜ | ⬜ | ⬜ | T2 | |
| Q-08 | Streaming robuste aux fragments | ✅ | ✅ | ⬜ | T1 | Tests : découpage à chaque taille, UTF-8 et CRLF coupés. |
| Q-09 | Retry configurable (transitoires + 400 JSON tronqué ciblé) | ✅ | ✅ | ⬜ | T1 | Tests : 503 puis succès, 400 ordinaire jamais retenté, 400 « JSON tronqué » retenté. |
| Q-10 | Reprise des réponses interrompues, aucun outil rejoué | ⬜ | ⬜ | ⬜ | T3 | |
| Q-11 | Historique reconstruit après changement de fournisseur | ⬜ | ⬜ | ⬜ | T2 | |

## 8. Modes, agents, orchestration

| ID | Fonctionnalité | D | C | S | T | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| A-01 | Mode Chat vs Agent | ⬜ | ⬜ | ⬜ | T3 | |
| A-02 | Agent Plan / Proposition / Exécution appliqués par le moteur | ⬜ | ⬜ | ⬜ | T3 | |
| A-03 | Sous-agents (auto/forcé/désactivé, budgets, profondeur, parallélisme, rôles, préréglages) | ⬜ | ⬜ | ⬜ | T7 | |
| A-04 | Worktrees Git pour sous-agents | ⬜ | ⬜ | ⬜ | T7 | |
| A-05 | Suivi, rapports, annulation propagée, statut terminé/interrompu/budget | ⬜ | ⬜ | ⬜ | T7 | |
| A-06 | Questions interactives (unique/multiple/libre/strict, accordéon, navigation) | ⬜ | ⬜ | ⬜ | T3 | |
| A-07 | Propositions d'actions (4 types, clic unique, consigne consultable) | ⬜ | ⬜ | ⬜ | T3 | |
| A-08 | Détection de boucle configurable | ⬜ | ⬜ | ⬜ | T3 | |

## 9. Skills, MCP, outils

| ID | Fonctionnalité | D | C | S | T | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| K-01 | Skills activables et configurables individuellement | ⬜ | ⬜ | ⬜ | T3 | |
| K-02 | Information (date, système, conversation) | ⬜ | ⬜ | ⬜ | T3 | |
| K-03 | Sources : lister, lire, glob, grep | ⬜ | ⬜ | ⬜ | T3 | |
| K-04 | Création/édition de fichiers, patch multi-fichiers prévisualisé | ⬜ | ⬜ | ⬜ | T3 | |
| K-05 | Git (état, diff, log, branches, staging, commit, sync) | ⬜ | ⬜ | ⬜ | T4 | |
| K-06 | Index `index.ohm` | ⬜ | ⬜ | ⬜ | T6 | |
| K-07 | RAG local/distant | ⬜ | ⬜ | ⬜ | T6 | |
| K-08 | Terminaux asynchrones | ⬜ | ⬜ | ⬜ | T3 | |
| K-09 | Scripts Python | ⬜ | ⬜ | ⬜ | T6 | Nécessite un Python fourni ou détecté. |
| K-10 | Recherche web et lecture de pages/API (artefacts, SSRF bloqué) | ⬜ | ⬜ | ⬜ | T6 | |
| K-11 | Navigateur intégré et DOM | ⬜ | ➖ | ➖ | T4 | CLI/serveur : via MCP si configuré. |
| K-12 | Captures d'écran | ⬜ | ➖ | ➖ | T4 | |
| K-13 | Contrôle applications/souris/clavier | ⬜ | ➖ | ➖ | T11 | |
| K-14 | Vision dédiée | ⬜ | ⬜ | ⬜ | T8 | |
| K-15 | Générateur d'assets (skill) | ⬜ | ⬜ | ⬜ | T8 | |
| K-16 | Mémoire | ⬜ | ⬜ | ⬜ | T6 | |
| K-17 | Planification, synthèse, revue de code, conception complète | ⬜ | ⬜ | ⬜ | T3 | |
| K-18 | Skills personnalisés `SKILL.md` (global/projet), création/chargement | ⬜ | ⬜ | ⬜ | T6 | |
| K-19 | MCP : gestion, import JSON prévisualisé, connexion, découverte, activation par conversation, `/mcp` | ⬜ | ⬜ | ⬜ | T6 | |

## 10. Autorisations et isolation

| ID | Fonctionnalité | D | C | S | T | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| G-01 | Politique Refuser tout / Demander / Règles | ⬜ | ⬜ | ⬜ | T3 | |
| G-02 | Accords ponctuels et persistants, règles outil/famille/ressource/projet, conflits | ⬜ | ⬜ | ⬜ | T3 | |
| G-03 | Historique des décisions | ⬜ | ⬜ | ⬜ | T3 | |
| G-04 | Fenêtre d'autorisation (action, cible, paramètres, changements) | ⬜ | ⬜ | ⬜ | T3 | |
| G-05 | Bouclier par bulle d'outil + détails | ⬜ | ⬜ | ⬜ | T3 | |
| G-06 | `edit_source` Raw/Formatted, diff ligne/bloc coloré, hors thread UI | ⬜ | ⬜ | ⬜ | T3 | |
| G-07 | Sandbox (copie, diff, application sélective) | ⬜ | ⬜ | ⬜ | T7 | |

## 11. Contrôle desktop sans curseur

| ID | Fonctionnalité | D | C | S | T | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| X-01 | Windows : Auto / UIA-API / Legacy séparés souris/clavier | ⬜ | ➖ | ➖ | T11 | |
| X-02 | Repli Legacy désactivé par défaut, conditions propres | ⬜ | ➖ | ➖ | T11 | |
| X-03 | Mode réel et raison du repli affichés | ⬜ | ➖ | ➖ | T11 | |
| X-04 | Capacités Linux/macOS déclarées | ⬜ | ➖ | ➖ | T11 | |

## 12. Mémoire, index, RAG

| ID | Fonctionnalité | D | C | S | T | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Y-01 | Mémoire conversation / projet / générale / utilisateur, versions, provenance | ⬜ | ⬜ | ⬜ | T6 | |
| Y-02 | Vue administrative filtrable, triable, paginée | ⬜ | ⬜ | ⬜ | T6 | |
| Y-03 | Lecture initiale forcée (bornée) et écriture forcée (désactivées par défaut) | ⬜ | ⬜ | ⬜ | T6 | |
| Y-04 | Index portable `index.ohm` | ⬜ | ⬜ | ⬜ | T6 | |
| Y-05 | RAG : ressources autorisées, embeddings locaux/distants, index périmé, annulable | ⬜ | ⬜ | ⬜ | T6 | |

## 13. Panneaux et outils dédiés

| ID | Fonctionnalité | D | C | S | T | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| W-01 | Navigateur : onglets, adresse, navigation, plein écran, DOM, captures, vue mobile, suspension | ⬜ | ➖ | ➖ | T4 | |
| W-02 | Terminaux multiples par conversation | ⬜ | ⬜ | ⬜ | T4 | |
| W-03 | Explorateur de fichiers + aperçu Raw/Preview | ⬜ | ⬜ | ⬜ | T4 | |
| W-04 | Panneau Git + propositions de modifications | ⬜ | ⬜ | ⬜ | T4 | |
| W-05 | Traducteur et correcteur | ⬜ | ⬜ | ⬜ | T8 | |
| W-06 | Générateur d'assets (vectoriel, pixel art, animation, exports) | ⬜ | ➖ | ➖ | T8 | |
| W-07 | Benchmark | ⬜ | ⬜ | ⬜ | T8 | |
| W-08 | Détection de contenu IA | ⬜ | ⬜ | ⬜ | T8 | |

## 14. Statistiques, diagnostics, tâches planifiées

| ID | Fonctionnalité | D | C | S | T | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Z-01 | Registre de consommation (tous types d'appels, exact/estimé/incomplet) | ⬜ | ⬜ | ⬜ | T2 | |
| Z-02 | Dashboard (courbes, filtres, export CSV) | ⬜ | ⬜ | ⬜ | T9 | |
| Z-03 | Diagnostics (logs, CPU/RAM/GPU, backend de rendu, stockage, export expurgé) | ⬜ | ⬜ | ⬜ | T9 | |
| Z-04 | Tâches planifiées CRON (fuseau, prochaine échéance, historique) | ⬜ | ⬜ | ⬜ | T9 | |

## 15. Apparence et réglages

| ID | Fonctionnalité | D | C | S | T | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| S-01 | Navigation recherchable, ordre imposé (Avancé avant Réinitialisation) | ✅ | ⬜ | ⬜ | T1 | Sections non implémentées affichées avec leur tranche, sans réglage factice. |
| S-02 | Clair / sombre / système, thèmes intégrés, Fluent sombre V2 (#1D6FC8) | ✅ | 🟡 | ⬜ | T1 | CLI : thèmes monolith, fluent, crt-green, crt-amber, neon. |
| S-03 | Palettes personnalisées, couleurs messages, polices, densité, zoom | 🟡 | ➖ | ⬜ | T1 | Couleurs des messages, polices, taille, densité, zoom ; palettes personnalisées en T9. |
| S-04 | Nom et logo personnalisables (clair/sombre) | ⬜ | ➖ | ⬜ | T9 | |
| S-05 | Animations de fond (désactivées par défaut) | ⬜ | ➖ | ➖ | T9 | |
| S-06 | Avancé : backend GPU, accélération, rafraîchissement, valeurs réellement utilisées | ⬜ | ➖ | ➖ | T9 | |
| S-07 | Notifications (cloche, système, son) | ⬜ | ⬜ | ⬜ | T9 | |
| S-08 | Archivage/suppression/nettoyage automatiques, réinitialisations ciblées | ⬜ | ⬜ | ⬜ | T9 | |
| S-09 | Annuler restaure l'état initial ; enregistrements immédiats signalés | ✅ | ⬜ | ➖ | T1 | Aperçu en direct, Annuler restaure ; connexions et réinitialisations marquées « enregistré immédiatement ». |

## 16. Plateformes

| ID | Capacité | Windows | Linux | macOS | Notes |
| --- | --- | --- | --- | --- | --- |
| O-01 | Desktop Electron | 🟡 dev + empaqueté vérifiés | ⬜ non testé | ⬜ planifié | macOS : architecture prévue, non construit ni testé. |
| O-02 | CLI | ✅ bundle Node 24 | ⬜ non testé | ⬜ planifié | Exécutable autonome (SEA) en T14. |
| O-03 | Serveur + service système | ⬜ | ⬜ | ➖ | Hors cahier des charges. |
| O-04 | Protection des secrets système | ✅ DPAPI | 🟡 libsecret, non testé | 🟡 Trousseau, non vérifié | |
| O-05 | Contrôle desktop sémantique | ⬜ UIA | ⬜ AT-SPI (à évaluer) | ⬜ AX (planifié) | |
| O-06 | Android (présent en v1) | ➖ | ➖ | ➖ | **Hors périmètre v3** — signalé : la v1 avait une app Flutter Android. |

## 17. Serveur

| ID | Fonctionnalité | S | T | Notes |
| --- | --- | --- | --- | --- |
| V-01 | Admin web, API documentée, temps réel | ⬜ | T13 | |
| V-02 | Comptes, rôles, permissions, projets par utilisateur/rôle | ⬜ | T13 | |
| V-03 | Fournisseurs partagés, clés côté serveur | ⬜ | T13 | |
| V-04 | Exécution cloud, files, simultanéité | ⬜ | T13 | |
| V-05 | Tâches planifiées sans client | ⬜ | T13 | |
| V-06 | Partage en direct local, commentaires, révocation | ⬜ | T13 | |
| V-07 | Synchronisation cloud → clients | ⬜ | T13 | |
| V-08 | Statistiques partagées sur consentement, audit, message admin | ⬜ | T13 | |
| V-09 | Service système, redémarrage après panne, mise à jour et sauvegarde documentées | ⬜ | T13 | |

## 18. Distribution et validation

| ID | Fonctionnalité | Statut | T | Notes |
| --- | --- | --- | --- | --- |
| B-01 | Scripts de build reproductibles | 🟡 | T0 | Bundles et paquet Windows non compressé vérifiés ; zip/NSIS et paquets Linux non encore produits localement. |
| B-02 | Workflows GitHub (CI, release brouillon manuelle) | 🟡 | T0 | CI et release brouillon (manuelle) écrites ; jamais exécutées (aucun push). |
| B-03 | Paquets Windows/Linux, archives sans données, SHA-256 | ⬜ | T14 | |
| B-04 | Licences des dépendances | ✅ | T0 | `npm run licenses` : 128 paquets, échec sur licence incompatible ; PrimeVue figé en 4.5 MIT. |
| B-05 | Mise à jour vérifiée avec sauvegarde | ⬜ | T14 | |
| B-06 | Tests unitaires / intégration / parcours / visuels / accessibilité / perf | 🟡 | continu | 34 tests (unitaires, intégration, parcours CLI) et captures de la fenêtre réelle ; accessibilité et performances reproductibles en T14. |
