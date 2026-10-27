# Inventaire de la v1 (Monolith Harness 2.8.0)

Inventaire réalisé le 2026-10-27 sur `E:\Projects\MonolithHarness` (128 commits, dernier : « Align CLI and Electron compatibility tests with the command validator »). La v1 n'est **pas modifiée** et ses données ne sont **pas importées** (décision utilisateur).

Portée : structure du dépôt, README, AGENTS.md, CHANGELOG (2.4 → 2.8), `docs/`, schéma EF Core (36 migrations), noms d'outils présents dans le code. Le code .NET n'a pas été audité ligne à ligne ; les divergences ci-dessous sont celles qu'on peut établir à partir de ces sources.

## Stack v1

| Élément | v1 |
| --- | --- |
| GUI | .NET 10 + Uno Platform (WinUI natif Windows, Skia desktop), plus un hôte Electron historique (`desktop/`, sidecar .NET) |
| CLI | .NET, exécutable autonome |
| Android | Flutter |
| Serveur | ASP.NET Core + EF Core SQLite |
| Données | `database.sqlite` + `workspace/` à côté du lanceur, `MCP.json`, `.linux-key` (Linux) |
| Secrets | `ProtectedKey` (DPAPI) sous Windows ; clé fichier `.linux-key` sous Linux |

## Modèle de données v1 (entités)

`States` (état global, skills activés, `FeaturesJson`), `Projects` (icône, couleur, `SourceFolder` unique, instructions, profil de permissions JSON), `Chats` (mode d'exécution/interaction/orchestration, ressources JSON, sandbox, favoris/épinglé/archivé), `Messages` (contenu, `WireJson`, tokens, état), `Attachment` (binaire en base), `PendingInputs` (file d'attente), `PermissionGrants`, `Templates`, `Providers` (kind, base URL, modèles JSON, contexte, composite, ACP), `McpServers`, `Memories` (portée, partition, version), `RagChunks` (vecteurs en base), `ScheduledTasks`, `Subagents`, `TokenUsages`, `ExternalChatSessions`.

Leçons appliquées à la v3 :

* Plusieurs colonnes JSON opaques (`FeaturesJson`, `AgentOptionsJson`, `ResourcePathsJson`) → la v3 normalise ce qui est filtré/joint (ressources, modèles, règles) et garde du JSON uniquement pour des réglages typés validés.
* Pièces jointes binaires en base → fichiers adressés par contenu.
* Un seul `SourceFolder` par projet en v1 alors que le cahier demande plusieurs dossiers → table `project_folders`.

## Outils exposés au modèle en v1 (relevés dans le code)

Sources : `list_sources`, `read_source`, `glob_sources`, `grep_sources`, `write_source(s)`, `edit_source`, `apply_patch`, `propose_file_changes`.
Terminaux : `create_terminal`, `run_terminal`, `read_terminal`, `list_terminals`, `delete_terminal`.
Git : `git_status`, `git_diff`, `git_log`, `git_branches`, `git_stage`, `git_unstage`, `git_commit`, `git_fetch`, `git_pull`, `git_push`, `git_switch`, `git_init`, `git_changes`.
Python : `write_python_script`, `run_python_script`, `python_info`.
Web : `web_http_search`, `web_http_read`, `web_http_request`, `web_http_configure`.
Navigateur : `browser_tabs`, `browser_tab_new/select/close`, `read_page`, `browser_dom`, `browser_javascript`, `browser_screenshot`, `browser_mouse`, `browser_keyboard`, `browser_viewport`, `browser_download_url`.
Desktop : `mouse_control`, `keyboard_control`, captures, liste d'applications.
Mémoire : `memory_search`, `memory_read`, `memory_save`, `memory_delete`.
RAG : `rag_index`, `rag_search`, `rag_read`, `rag_sources`.
Assets : `asset_create`, `asset_edit`, `asset_inspect`, `asset_guides`, `asset_capture`, `asset_export`.
Divers : `create_skill`, `read_skill_resource`, `image_generation`, `list_images`.

La v3 conserve ces familles ; les noms sont réévalués pour rester cohérents (préfixe par famille).

## Divergences documentation ↔ implémentation constatées

| # | Constat | Sources |
| --- | --- | --- |
| D1 | `desktop/package.json` est en **1.84.0** alors que l'application est en **2.8.0** ; AGENTS.md exige pourtant l'alignement des versions de l'hôte Electron. | `desktop/package.json`, `AGENTS.md`, `CHANGELOG.md` |
| D2 | L'hôte Electron se décrit « for macOS and Windows » alors que le README annonce le desktop Windows / Linux ; aucune cible Linux dans sa config electron-builder hors icône. | `desktop/package.json`, `README.md` |
| D3 | `docs/feature-comparison.md` indique que les liens de téléchargement pointent sur 1.88.1, alors que le README pointe sur 2.8.0 : document de comparaison périmé. | `docs/feature-comparison.md`, `README.md` |
| D4 | Sous Linux, la clé de chiffrement est un fichier `.linux-key` à côté de la base : ce n'est pas un mécanisme de protection système (le cahier des charges demande « protection des clés par les mécanismes du système »). | `docs/portable-workspace.md` |
| D5 | Lecture mémoire forcée fixée à **20** entrées dans le changelog 2.8.0, sans réglage de borne. La v3 rend ce nombre configurable et borné. | `CHANGELOG.md` 2.8.0 |
| D6 | Le README présente l'application Android ; le cahier des charges v3 ne la mentionne pas → **retirée du périmètre v3, signalé** (matrice O-06). | `README.md` |
| D7 | Les tâches planifiées nécessitent l'application ouverte (documenté) : conforme au cahier, à conserver explicitement. | `docs/feature-comparison.md` |
| D8 | Les noms de releases historiques sont gérés par `build/LegacyReleaseNames.json` ; la v3 doit préserver la compatibilité des noms de téléchargement si elle remplace la v1 sur le même dépôt GitHub (à décider au moment de la première release). | `AGENTS.md`, `build/` |

## Conventions v1 conservées

* Actions principales des fenêtres en bas à droite, barre stable, action principale accentuée (AGENTS.md).
* SemVer + changelog daté en tête, versions GUI/CLI/serveur alignées.
* Aucune modification GitHub (push, tag, release) sans demande explicite ; releases en brouillon avec `SHA256SUMS.txt`, sans données utilisateur.
* Dossiers de publication `artifacts/GUI`, `artifacts/CLI`, `artifacts/SERVER`, `artifacts/TEMP`.
