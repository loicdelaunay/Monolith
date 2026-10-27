# Matrice des fonctionnalités et suivi

Légende : ✅ réalisé et vérifié · 🟡 partiel (détail en note) · ⬜ restant · ⛔ bloqué (raison) · ➖ non applicable à cette plateforme (raison).
Colonnes : **D** desktop (Windows/Linux), **C** CLI, **S** serveur. **T** = tranche prévue ([ROADMAP](ROADMAP.md)). macOS : voir §16.

Un ✅ signifie que l'action est réellement exécutée par le moteur et couverte par un test ou une vérification manuelle documentée ; jamais une interface sans traitement.

**Dernière mise à jour : 2026-10-27, fin de la tranche T6 (3.0.0-alpha.6).**

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
| P-05 | Ressources propres à une conversation (fichiers, dossiers, héritage) + retour aux valeurs du projet | ✅ | ✅ | ⬜ | T3 | Ressources héritées ou propres (dossiers, fichiers), retour au projet ; CLI `/resources`. |
| P-06 | Fichier attaché = accès à ce seul fichier | ✅ | ✅ | ⬜ | T3 | Test : fichier joint accessible, dossier parent refusé. |
| P-07 | Espace privé persistant pour conversation sans dossier | ✅ | ✅ | ⬜ | T3 | `workspace/conversations/<id>` créé à la demande (test). |
| P-08 | Instructions de projet (menu contextuel + fenêtre) | ✅ | ⬜ | ⬜ | T1 | Menu contextuel et fenêtre ; appliquées aux prochains envois (testé côté moteur). |
| P-09 | Import + prévisualisation `permission.json` | ✅ | ⬜ | ⬜ | T3 | Fenêtre du projet : aperçu des règles puis import ; formats `rules` et `allow/deny/ask` (test). |
| P-10 | Fichiers d'instructions du projet et sous-dossiers avec portée explicite | ✅ | ✅ | ⬜ | T3 | AGENTS.md, CLAUDE.md, .monolith/instructions.md jusqu’à 3 niveaux, chacun avec sa portée (test). |

## 3. Conversations

| ID | Fonctionnalité | D | C | S | T | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| C-01 | Plusieurs conversations et générations simultanées | ✅ | ✅ | ⬜ | T1 | Test : deux générations parallèles. |
| C-02 | Créer, renommer, rechercher, favoris, épingler, archiver, supprimer | ✅ | ✅ | ⬜ | T1 | Recherche FTS5 titres + messages. |
| C-03 | Réorganisation dans la barre latérale | ✅ | 🟡 | ➖ | T1 | Desktop : glisser-déposer (ordre et déplacement entre projets). CLI : `/move` entre projets. |
| C-04 | Brouillons par conversation | ✅ | ✅ | ➖ | T1 | |
| C-05 | Nommage automatique (fournisseur/modèle dédiés) | ✅ | ✅ | ⬜ | T2 | Requête dédiée (connexion/modèle configurables), consommation « naming » à part, titre utilisateur jamais remplacé (test). |
| C-06 | Objectif persistant | ✅ | ✅ | ⬜ | T2 | En-tête et `/goal` ; transmis au modèle à chaque envoi. |
| C-07 | Modèles de messages | ✅ | 🟡 | ⬜ | T2 | Desktop : insertion, création depuis le brouillon, gestion. CLI : liste et insertion (`/templates`, `/template`). |
| C-08 | Export Markdown | ✅ | ✅ | ⬜ | T2 | Avec ou sans réflexion ; dialogue natif « Enregistrer sous » ; le CLI refuse d’écraser un fichier. |
| C-09 | Duplication / bifurcation depuis un message | ✅ | ✅ | ⬜ | T2 | Depuis un message ou le menu ; provenance conservée (test). |
| C-10 | « Reprendre ici » (texte + pièces jointes dans l'éditeur), historique précédent préservé | ✅ | ✅ | ⬜ | T2 | Texte et pièces jointes replacés dans l’éditeur ; historique complet sauvegardé dans une conversation archivée (tests). |
| C-11 | File d'attente : édition, suppression, réordonnancement | ✅ | 🟡 | ⬜ | T2 | Desktop : panneau (modification, suppression, ordre, pause/reprise). CLI : `/queue`, `/unqueue`, `/next`. |
| C-12 | Instruction pendant génération, traitée à une frontière contrôlée | ✅ | ✅ | ⬜ | T2 | Alt+Entrée / `/steer` ; frontière = fin du tour en cours (frontières entre outils en T3). Test : même instantané. |
| C-13 | Annulation d'une génération et de ses travaux enfants | 🟡 | 🟡 | ⬜ | T1 | Annulation de la génération testée (contenu partiel conservé, aucune nouvelle tentative) ; travaux enfants : T7. |
| C-14 | Instantané de configuration par génération | ✅ | ✅ | ⬜ | T1 | Test : changement de modèle pendant la génération sans effet. |

## 4. Interface desktop

| ID | Fonctionnalité | D | C | S | T | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| U-01 | Barre latérale projets/conversations/recherche/notifications | 🟡 | ➖ | ➖ | T1 | Projets, conversations, recherche ; notifications en T9. |
| U-02 | Panneau d'outils redimensionnable (navigateur, terminaux, Git, fichiers, assets, aperçu) | 🟡 | ➖ | ➖ | T4 | Fichiers, Terminal, Git, Navigateur, Aperçu : redimensionnable, agrandir, fermer, Ctrl+J, état conservé (parcours visuel). Onglet Assets avec le générateur (T8). |
| U-03 | Barre supérieure : identité unique, contrôles natifs uniques, repli système, drag jusqu'au bord | 🟡 | ➖ | ➖ | T1 | Identité unique, contrôles natifs superposés (un seul jeu), repli « cadre système », zone de déplacement jusqu’au bord. À vérifier manuellement : déplacement depuis une fenêtre maximisée. |
| U-04 | Bouton version → changelog intégré | ✅ | ✅ | ⬜ | T1 | CLI : `/changelog`. |
| U-05 | Menu outils dédiés en bas de la barre latérale, à côté de Réglages | ⬜ | ➖ | ➖ | T8 | |
| U-06 | Saisie multiligne, Entrée/Maj+Entrée, collage, glisser-déposer | ✅ | 🟡 | ➖ | T1 | Pièces jointes par bouton, glisser-déposer et collage (vérifié dans la fenêtre réelle). CLI : `/attach`. |
| U-07 | Autocomplétion commandes et skills | 🟡 | 🟡 | ➖ | T2 | Commandes « / » dans l’éditeur desktop et autocomplétion CLI ; skills en T6. |
| U-08 | Agrandissement de la saisie au-delà de 10 lignes, retour sans perte | ✅ | ➖ | ➖ | T1 | |
| U-09 | Débit et utilisation du contexte (optionnels) | ✅ | 🟡 | ➖ | T2 | Débit et utilisation du contexte (réglages). CLI : `/context`. |
| U-10 | Accessibilité : clavier, focus visible, libellés, texte agrandi, petites fenêtres | 🟡 | ➖ | ⬜ | T1→T14 | Navigation clavier, focus visible, libellés ARIA, mise en page étroite ; audit complet en T14. |

## 5. Chat, rendu et historique

| ID | Fonctionnalité | D | C | S | T | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| R-01 | Markdown, tableaux, listes, citations, liens | ✅ | 🟡 | ⬜ | T1 | CLI : rendu texte simplifié. |
| R-02 | Code coloré, copie, numéros de ligne | ✅ | 🟡 | ⬜ | T1 | Shiki chargé à la demande, copie, numéros de ligne (réglage). CLI : blocs colorés sans coloration syntaxique. |
| R-03 | Images et documents (limites explicites) | 🟡 | 🟡 | ⬜ | T2 | Images PNG/JPEG/WebP/GIF ≤ 10 Mo et texte UTF-8 ≤ 1 Mo, contenu vérifié ; PDF et documents bureautiques non pris en charge (refus expliqué). |
| R-04 | Mermaid | ✅ | ⬜ | ⬜ | T4 | Rendu local à la demande (sécurité stricte), différé pendant le streaming, bascule code/diagramme ; bloc invalide affiché comme code. CLI : source affichée. |
| R-05 | LaTeX en ligne et en bloc | ✅ | ⬜ | ⬜ | T4 | KaTeX à la demande : `$…$`, `\(…\)`, `$$…$$`, `\[…\]` ; montants « 5 $ » ignorés ; erreurs affichées sans casser le message. |
| R-06 | Cartes web et aperçus interactifs isolés | 🟡 | ➖ | ⬜ | T4 | Aperçus HTML (iframe `sandbox` vide : ni script, ni formulaire, ni accès à l'application) et SVG. Cartes de liens web : T6 avec la recherche web. |
| R-07 | Réglages indépendants par type de rendu | ⬜ | ⬜ | ➖ | T4 | |
| R-08 | Styles de réponse (défaut, court, pragmatique, détaillé, ludique) | ✅ | 🟡 | ⬜ | T1 | Appliqué par le moteur ; CLI : réglage partagé, pas de commande dédiée. |
| R-09 | Badges de fichiers vérifiés (existence, ligne, type) | ✅ | ⬜ | ⬜ | T4 | Chemins cités vérifiés sur le disque dans la portée de la conversation (`chemin:ligne`, `#L12`) ; clic = aperçu dans le panneau (test + parcours visuel). |
| R-10 | Réflexion : affichage Aucun / Réduit / Détaillé | ✅ | ✅ | ⬜ | T2 | Réglage distinct du niveau demandé. |
| R-11 | Chronologie réflexion/outils/réponses | ✅ | ✅ | ⬜ | T2 | Réflexion, texte, appels d’outils et réponses aux questions dans l’ordre d’arrivée ; les tours successifs restent dans une même réponse. |
| R-12 | Défilement : suivi auto, suspension, position conservée | 🟡 | ➖ | ➖ | T1 | Suivi, suspension (molette/clavier), reprise en bas, sans polling ; test automatisé à ajouter. |
| R-13 | Virtualisation des longues conversations | 🟡 | ➖ | ➖ | T2 | `content-visibility` + fenêtre de 80 messages chargée à la demande, position conservée ; mesure sur très longue conversation à faire. |

## 6. Fournisseurs et modèles

| ID | Fonctionnalité | D | C | S | T | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| M-01 | OpenAI-compatible | ✅ | ✅ | ⬜ | T1 | |
| M-02 | DeepSeek | ✅ | ✅ | ⬜ | T1 | `reasoning_content` et `prompt_cache_hit_tokens` pris en charge. |
| M-03 | Google AI Studio / Gemini | ✅ | 🟡 | ⬜ | T5 | Adaptateur natif : `streamGenerateContent` SSE, `systemInstruction`, outils (`parametersJsonSchema`), images, réflexion (`thinkingBudget` 2.5 / `thinkingLevel` 3, pensées affichées), signatures de réflexion conservées et renvoyées, catalogue paginé (tests contre serveur simulé). Non vérifié contre l'API réelle sur ce poste (pas de clé). CLI : utilisable, configuration dans l'interface desktop. |
| M-04 | Vertex AI (ADC/OAuth, clé, Express) | 🟡 | 🟡 | ⬜ | T5 | Clé Express, ADC (connexion gcloud ou compte de service via GOOGLE_APPLICATION_CREDENTIALS) et JSON de compte de service chiffré (JWT RS256 signé localement, test avec serveur de jetons simulé). Flux OAuth interactif dans l'application : non fait (utiliser `gcloud auth application-default login`). Liste de modèles documentée (le catalogue Vertex n'expose pas les limites). Non vérifié contre Google Cloud réel. |
| M-05 | OpenRouter, Z.ai, Groq, Mistral, NVIDIA | 🟡 | 🟡 | ⬜ | T5 | Préréglages compatibles OpenAI avec transports de réflexion dédiés (OpenRouter `reasoning`, Z.ai `thinking`) ; non vérifiés contre les services réels (pas de clés). |
| M-06 | OpenCode | 🟡 | 🟡 | ⬜ | T5 | Via ACP (`opencode acp`), préréglage prêt. OpenCode n'est pas installé sur ce poste : non vérifié avec le vrai binaire. |
| M-07 | Agents externes ACP | ✅ | 🟡 | ⬜ | T5 | Client ACP (JSON-RPC stdio) : session par conversation, réflexion, plan, actions affichées, demandes d'autorisation soumises aux règles et au mode, lecture/écriture de fichiers limitées à la portée, annulation, arrêt de l'arbre de processus. Préréglages OpenCode, Gemini CLI, Claude Code. Vérifié avec un agent ACP de test ; agents réels non installés ici. |
| M-08 | Modèles locaux (GGUF, HF, llama.cpp) | ⬜ | ⬜ | ⬜ | T10 | |
| M-09 | Modèles composés (orchestrateur + spécialistes) | ✅ | 🟡 | ⬜ | T5 | Outil `consult_specialist`, consultations parallèles affichées, consommation cumulée, imbrication refusée, limite de consultations (test). CLI : utilisable, configuration dans l'interface desktop. |
| M-10 | Connexions multiples indépendantes du même fournisseur | ✅ | ✅ | ⬜ | T1 | Duplication avec clé recopiée. |
| M-11 | Écran liste/détail, logos locaux, onglets Connexion/Modèles/Avancé | ✅ | ➖ | ⬜ | T1 | CLI : `/providers` (lecture seule). |
| M-12 | Clé masquée, remplacement explicite, validation non restrictive | ✅ | ✅ | ⬜ | T1 | Aucune règle de préfixe ; seuls espaces, contrôles et non-ASCII refusés. |
| M-13 | Test de connexion (résultat sous le bouton) | ✅ | ⬜ | ⬜ | T1 | Résultat sous le bouton ; test par génération seulement si autorisé. |
| M-14 | Import catalogue, recherche, sélection, pagination, ajout manuel | ✅ | ⬜ | ⬜ | T1 | |
| M-15 | Sélecteur fournisseur puis modèle dans le chat | ✅ | 🟡 | ➖ | T1 | CLI : `/model [connexion/]modèle`. |
| M-16 | Raccourcis fournisseur/modèle/mode/réflexion | ✅ | 🟡 | ➖ | T5 | Desktop : Ctrl+Maj+M (mode), Ctrl+Maj+R (réflexion), raccourcis personnalisés enregistrables (Réglages › Raccourcis). CLI : `/shortcut` et Alt+chiffre (les terminaux ne transmettent pas Ctrl+Maj). |
| M-17 | Génération d'images (locale ou distante) | ⬜ | ⬜ | ⬜ | T8 | |

## 7. Réflexion, contexte, fiabilité

| ID | Fonctionnalité | D | C | S | T | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Q-01 | Niveaux de réflexion déclarés uniquement, Auto si inconnu, interrupteur simple | ✅ | ✅ | ⬜ | T2 | Table documentée + catalogue OpenRouter + déclaration utilisateur ; interrupteur simple pour Z.ai ; Auto seul si inconnu. |
| Q-02 | Niveau demandé / envoyé / paramètre / repli affichés | ✅ | ✅ | ⬜ | T2 | Pied de réponse (desktop) et ligne de métadonnées (CLI). |
| Q-03 | « Sans réflexion » réel ou incompatibilité signalée | 🟡 | 🟡 | ⬜ | T2 | Chat et Agent : désactivation réelle ou refus explicite (tests). Correcteur en T8. |
| Q-04 | Niveau rejeté retiré jusqu'à réévaluation | ✅ | ✅ | ⬜ | T2 | Niveau refusé mémorisé, retiré des choix jusqu’à « Actualiser les capacités » (test). |
| Q-05 | Fenêtre de contexte / limite de sortie, auto ou personnalisée | ✅ | 🟡 | ⬜ | T2 | Par modèle : catalogue ou valeur personnalisée ; fenêtre et sortie distinctes. CLI : lecture seule. |
| Q-06 | Compteurs API ou estimation signalée, tokens en cache | ✅ | ✅ | ⬜ | T1 | Compteurs API, cache, estimation signalée ; utilisation de la fenêtre de contexte en T2. |
| Q-07 | Compactage manuel/auto, historique original conservé | 🟡 | 🟡 | ⬜ | T2 | Manuel et automatique, historique original conservé, noms des pièces jointes gardés ; préservation des échanges d’outils à vérifier en T3. |
| Q-08 | Streaming robuste aux fragments | ✅ | ✅ | ⬜ | T1 | Tests : découpage à chaque taille, UTF-8 et CRLF coupés. |
| Q-09 | Retry configurable (transitoires + 400 JSON tronqué ciblé) | ✅ | ✅ | ⬜ | T1 | Tests : 503 puis succès, 400 ordinaire jamais retenté, 400 « JSON tronqué » retenté. |
| Q-10 | Reprise des réponses interrompues, aucun outil rejoué | 🟡 | 🟡 | ⬜ | T3 | Aucun outil rejoué (retry bloqué dès qu’un appel est reçu ; appels interrompus marqués). Reprise automatique d’une réponse coupée : non implémentée. |
| Q-11 | Historique reconstruit après changement de fournisseur | ✅ | ✅ | ⬜ | T2 | Réflexion jamais renvoyée, images retirées pour un modèle sans vision, rôles fusionnés (test). |

## 8. Modes, agents, orchestration

| ID | Fonctionnalité | D | C | S | T | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| A-01 | Mode Chat vs Agent | ✅ | ✅ | ⬜ | T3 | Chat : outils conversationnels seulement ; Agent : outils selon le mode. |
| A-02 | Agent Plan / Proposition / Exécution appliqués par le moteur | ✅ | ✅ | ⬜ | T3 | Filtrage à l’exposition ET à l’exécution (tests : écriture refusée en Plan, proposition en Proposition). |
| A-03 | Sous-agents (auto/forcé/désactivé, budgets, profondeur, parallélisme, rôles, préréglages) | ⬜ | ⬜ | ⬜ | T7 | |
| A-04 | Worktrees Git pour sous-agents | ⬜ | ⬜ | ⬜ | T7 | |
| A-05 | Suivi, rapports, annulation propagée, statut terminé/interrompu/budget | ⬜ | ⬜ | ⬜ | T7 | |
| A-06 | Questions interactives (unique/multiple/libre/strict, accordéon, navigation) | ✅ | 🟡 | ⬜ | T3 | Desktop : tuiles, unique par défaut, multiple sur demande, texte, réponse libre, accordéon, navigation, annulation. CLI : réponses numérotées, sans retour arrière. |
| A-07 | Propositions d'actions (4 types, clic unique, consigne consultable) | ✅ | 🟡 | ⬜ | T3 | Desktop : boutons, consigne consultable, usage unique (test). CLI : affichage seulement. |
| A-08 | Détection de boucle configurable | ✅ | ✅ | ⬜ | T3 | Seuil, fenêtre, comparaison exacte/équivalente ; arrêter ou poursuivre une fois (test). |

## 9. Skills, MCP, outils

| ID | Fonctionnalité | D | C | S | T | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| K-01 | Skills activables et configurables individuellement | ✅ | 🟡 | ⬜ | T3 | Réglages › Skills ; CLI : réglage partagé, sans commande de bascule. |
| K-02 | Information (date, système, conversation) | ✅ | ✅ | ⬜ | T3 | Catégories date, système, conversation réglables. |
| K-03 | Sources : lister, lire, glob, grep | ✅ | ✅ | ⬜ | T3 | list_files, read_file, glob_files, grep_files dans la portée. |
| K-04 | Création/édition de fichiers, patch multi-fichiers prévisualisé | ✅ | ✅ | ⬜ | T3 | write_file, edit_file, apply_patch atomique avec aperçu (tests). |
| K-05 | Git (état, diff, log, branches, staging, commit, sync) | ✅ | 🟡 | ⬜ | T4 | Outils agent (lecture auto, écriture et réseau soumis aux autorisations, push/pull/fetch = effet réseau) + panneau Git (tests). CLI : outils de l'agent, sans commande `/git` dédiée. |
| K-06 | Index `index.ohm` | ✅ | ✅ | ⬜ | T6 | file_index_create/read/describe/update : JSON portable, exclusions, bornes (10 000 entrées, 16 Mio), empreintes, explications du modèle marquées à revoir si le contenu change, rapprochement à chaque lecture, jamais d'écriture en mode Plan (test). Maintenance immédiate après une écriture d'outil : au prochain accès. |
| K-07 | RAG local/distant | ✅ | ✅ | ⬜ | T6 | Index des ressources (FTS5) + embeddings facultatifs via une connexion compatible OpenAI, fusion des classements, indexation incrémentale annulable (test avec embeddings simulés). |
| K-08 | Terminaux asynchrones | ✅ | 🟡 | ⬜ | T3–T4 | Outils run_command / read_terminal / kill_terminal ; panneau Terminal (sortie en direct, arrêt, commandes lancées par l'utilisateur). CLI : outils de l'agent. |
| K-09 | Scripts Python | 🟡 | 🟡 | ⬜ | T6 | python_info / python_run (Python 3 du poste détecté : py, python3, python ; délai, sortie, code de retour). Aucun Python embarqué ; non testé automatiquement (dépend du poste). |
| K-10 | Recherche web et lecture de pages/API (artefacts, SSRF bloqué) | ✅ | ✅ | ⬜ | T6 | web_search (DuckDuckGo sans clé ou SearXNG), web_fetch (HTML → texte, JSON, texte), http_request ; adresses privées refusées à chaque redirection, 5 Mo max, contenu marqué non fiable (tests d'extraction et de garde ; pas d'appel Internet dans les tests). |
| K-11 | Navigateur intégré et DOM | ✅ | ➖ | ➖ | T4 | browser_open/read/dom/click/type : monde JS isolé, refus des champs mot de passe, adresses privées refusées à l'agent (SSRF). Parcours visuel. CLI/serveur : via MCP si configuré (T6). |
| K-12 | Captures d'écran | ✅ | ➖ | ➖ | T4 | Capture du navigateur intégré, de l'écran ou d'une fenêtre, jointe à la conversation et transmise aux modèles avec vision. Skill désactivé par défaut. |
| K-13 | Contrôle applications/souris/clavier | ⬜ | ➖ | ➖ | T11 | |
| K-14 | Vision dédiée | ⬜ | ⬜ | ⬜ | T8 | |
| K-15 | Générateur d'assets (skill) | ⬜ | ⬜ | ⬜ | T8 | |
| K-16 | Mémoire | ✅ | ✅ | ⬜ | T6 | memory_search / read / save / delete ; outils et administration (tests). |
| K-17 | Planification, synthèse, revue de code, conception complète | 🟡 | 🟡 | ⬜ | T3 | Plan : outil update_plan. Synthèse, revue de code et conception : skills d’instructions (sans outil dédié). |
| K-18 | Skills personnalisés `SKILL.md` (global/projet), création/chargement | ✅ | ✅ | ⬜ | T6 | Dossier skills de l'application et `.monolith/skills` / `.claude/skills` des ressources ; liste dans les instructions, load_skill, read_skill_resource, create_skill, activation individuelle (test). |
| K-19 | MCP : gestion, import JSON prévisualisé, connexion, découverte, activation par conversation, `/mcp` | ✅ | ✅ | ⬜ | T6 | stdio et HTTP streamable (session, flux SSE), secrets chiffrés (variables, en-têtes), import `mcpServers`/`servers` avec aperçu, effets déduits des annotations, activation par conversation, `/mcp` (tests stdio et HTTP). Transport SSE historique non pris en charge. |

## 10. Autorisations et isolation

| ID | Fonctionnalité | D | C | S | T | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| G-01 | Politique Refuser tout / Demander / Règles | ✅ | 🟡 | ⬜ | T3 | Réglages › Autorisations ; CLI : affichage de la politique (`/rules`). |
| G-02 | Accords ponctuels et persistants, règles outil/famille/ressource/projet, conflits | ✅ | 🟡 | ⬜ | T3 | Accords ponctuels, conversation, projet, global ; refus prioritaire puis spécificité (tests). CLI : règles globales `/allow`, `/deny`. |
| G-03 | Historique des décisions | ✅ | ⬜ | ⬜ | T3 | Historique filtrable par conversation (Réglages › Autorisations). |
| G-04 | Fenêtre d'autorisation (action, cible, paramètres, changements) | ✅ | ✅ | ⬜ | T3 | Action, cible, raison, paramètres et diff/commande attendus. |
| G-05 | Bouclier par bulle d'outil + détails | ✅ | 🟡 | ⬜ | T3 | Bouclier coloré + détails (règle, origine, décision, portée). CLI : symbole par ligne d’outil. |
| G-06 | `edit_source` Raw/Formatted, diff ligne/bloc coloré, hors thread UI | ✅ | 🟡 | ⬜ | T3 | Raw/Formatted, diff Myers ligne/bloc, couleurs, avant/après, numéros de ligne ; Web Worker au-delà de 40 000 caractères. CLI : résumé. |
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
| Y-01 | Mémoire conversation / projet / générale / utilisateur, versions, provenance | ✅ | ✅ | ⬜ | T6 | Versions conservées à chaque modification, provenance (vous, agent, écriture forcée), visibilité par portée (test). |
| Y-02 | Vue administrative filtrable, triable, paginée | ✅ | 🟡 | ⬜ | T6 | Réglages › Mémoire : recherche plein texte, filtre de portée, tri, pagination, édition, versions, suppression. CLI : `/memory` (liste et recherche). |
| Y-03 | Lecture initiale forcée (bornée) et écriture forcée (désactivées par défaut) | ✅ | ✅ | ⬜ | T6 | Lecture forcée bornée (1–100, 20 par défaut) dans les instructions (test) ; écriture forcée par requête dédiée comptabilisée. |
| Y-04 | Index portable `index.ohm` | ✅ | ✅ | ⬜ | T6 | Voir K-06. |
| Y-05 | RAG : ressources autorisées, embeddings locaux/distants, index périmé, annulable | 🟡 | 🟡 | ⬜ | T6 | Ressources de la conversation, embeddings distants (connexion compatible OpenAI, y compris serveurs locaux Ollama/llama.cpp), fichiers modifiés signalés, annulation. Modèle d'embeddings intégré (sans serveur) : avec les modèles locaux (T10). |

## 13. Panneaux et outils dédiés

| ID | Fonctionnalité | D | C | S | T | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| W-01 | Navigateur : onglets, adresse, navigation, plein écran, DOM, captures, vue mobile, suspension | 🟡 | ➖ | ➖ | T4 | Onglets, adresse/recherche, précédent/suivant, recharger, vue mobile, outils de développement, navigateur système, effacement des données, partition isolée, téléchargements bloqués. Suspension des onglets inactifs : T15 (perf). |
| W-02 | Terminaux multiples par conversation | ⬜ | ⬜ | ⬜ | T4 | |
| W-03 | Explorateur de fichiers + aperçu Raw/Preview | ✅ | ⬜ | ⬜ | T4 | Arborescence dans la portée, recherche par nom et contenu, aperçu rendu/source (Markdown, HTML isolé, SVG, images, code coloré). |
| W-04 | Panneau Git + propositions de modifications | ✅ | ⬜ | ⬜ | T4 | Statut, diff par fichier, indexer/désindexer/annuler (confirmation), commit, branches, historique, fetch/pull/push (confirmation pour push). |
| W-05 | Traducteur et correcteur | ⬜ | ⬜ | ⬜ | T8 | |
| W-06 | Générateur d'assets (vectoriel, pixel art, animation, exports) | ⬜ | ➖ | ➖ | T8 | |
| W-07 | Benchmark | ⬜ | ⬜ | ⬜ | T8 | |
| W-08 | Détection de contenu IA | ⬜ | ⬜ | ⬜ | T8 | |

## 14. Statistiques, diagnostics, tâches planifiées

| ID | Fonctionnalité | D | C | S | T | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Z-01 | Registre de consommation (tous types d'appels, exact/estimé/incomplet) | 🟡 | 🟡 | ⬜ | T2 | Chat, nommage et compactage enregistrés (exact/estimé/incomplet) ; `usage.list` ; mémoire, vision et sous-agents à venir. |
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
| B-06 | Tests unitaires / intégration / parcours / visuels / accessibilité / perf | 🟡 | continu | 90 tests (unitaires, intégration, parcours CLI) et captures de la fenêtre réelle ; accessibilité et performances reproductibles en T14. |
