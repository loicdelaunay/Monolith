# Changelog

Toutes les modifications visibles sont listées ici, de la plus récente à la plus ancienne. Versions alignées pour l'interface desktop, le CLI et le serveur.

## Non publié

- **Lecture de fichiers et de données** : en entier ou des lignes X à Y (start_line, end_line), pour read_file, les réponses web enregistrées, le texte des pages du navigateur et les ressources de skills. Plus de limite cachée de 2000 lignes ; un résultat trop long est coupé en fin de ligne avec la plage exacte à relire.
- **Zoom sur les diagrammes Mermaid** : bouton loupe ou double-clic pour ouvrir le diagramme en plein écran ; zoom à la molette (centré sur le curseur) ou avec + / −, déplacement en glissant, 0 ou double-clic pour ajuster à la fenêtre, Échap pour fermer.
- **Bloc réflexion et outils** : hauteur limitée, l'en-tête reste à portée ; le défilement interne suit les nouvelles étapes comme le chat (suspendu dès que vous remontez, repris en revenant en bas). L'en-tête peut afficher la dernière étape (outil et sa cible, ou dernier titre de la réflexion) à la place du seul « Réflexion » : réglage dans Réglages › Chat, activé par défaut.

## 3.0.0-alpha.22 — 2026-10-28

- **Diagrammes Mermaid** : de nouveau affichés comme diagrammes dans le chat (Mermaid 12 utilisait par défaut une disposition non incluse ; la disposition standard est imposée).
- **Réflexion et outils regroupés** : la réflexion et les appels d'outils qui se suivent forment un seul bloc repliable (« Réflexion · 3 outils »), avec l'outil en cours affiché pendant la génération. Restent visibles : autorisations en attente, propositions à valider, questions et suggestions.
- **Navigateur en mode Proposition** : le navigateur (intégré ou Chrome du poste) et le web sont disponibles en Agent · Proposition, avec autorisations ; auparavant réservés au mode Exécution, ils étaient invisibles pour le modèle dans le mode par défaut. Les commandes et le contrôle du bureau restent réservés à l'Exécution, et le modèle l'indique au lieu d'inventer une configuration manquante. Chrome DevTools MCP ne démarre plus deux fois lors de générations simultanées.
- **Nouvelle conversation** : reprend le dernier fournisseur, modèle et niveau de réflexion utilisés (réglable dans Réglages › Chat ; le modèle par défaut sert s'il n'est plus disponible).

## 3.0.0-alpha.21 — 2026-10-28

- **Pièces jointes : dossiers et fichiers jusqu’à 100 Mo**, dans le chat (« + › Joindre un dossier », glisser-déposer) et dans les projets. Un dossier est copié dans Monolith, sans dépendances, .git ni caches. Tous les types de fichiers sont acceptés : les images (jusqu’à 10 Mo) et le texte sont transmis au modèle (début du texte au-delà de 1 Mo ; arborescence et fichiers courts pour un dossier) ; le contenu complet est lisible par les outils en mode Agent, sans pouvoir être modifié.
- **Mode des nouvelles conversations** : Agent · Proposition par défaut, réglable dans Réglages › Chat ; une icône à droite des réglages rapides rappelle le mode de la conversation.

## 3.0.0-alpha.20 — 2026-10-28

- **Navigateur : Chrome du poste** (comme la v1) : Réglages › Skills › Navigateur permet de choisir entre le navigateur intégré et Chrome via Chrome DevTools MCP. Chrome démarre avec un profil dédié à Monolith, conservé dans le dossier de données ; un chemin vers Chrome peut être indiqué. Node.js et Google Chrome sont requis ; fonctionne aussi dans le CLI.
- **Adresses locales** (localhost, 127.0.0.1, réseau local) : le navigateur et le client HTTP ne les refusent plus d'office ; votre accord est demandé, une fois ou toujours pour l'hôte et le port. En mode Autoriser tout, elles passent sans question.
- **Pièces jointes de projet** : la fenêtre Nouveau projet / Modifier le projet accepte des fichiers (texte et images, 20 au plus, glisser-déposer ou bouton) à côté des instructions. Ils sont transmis au modèle au début de chaque conversation du projet.
- **Plan terminé** : il disparaît du haut de la zone de saisie et reste dans la conversation sous forme de carte « Plan exécuté » (repliée, étapes visibles au clic).

## 3.0.0-alpha.19 — 2026-10-28

- **Mise à jour intégrée (Windows)** : l'installation ne démarrait jamais. PowerShell lancé détaché quittait sans exécuter le script, et lancé directement il était arrêté avec l'application. L'installateur passe désormais par `cmd /c start` et s'exécute après la fermeture de Monolith. Vérifié de bout en bout depuis GitHub : recherche, téléchargement, contrôle SHA-256, installation (ancienne version conservée dans `previous`) et redémarrage dans la nouvelle version. Les versions alpha.17 et alpha.18 doivent être mises à jour une fois à la main.

## 3.0.0-alpha.18 — 2026-10-28

- **Certificats HTTPS des fournisseurs** (erreur `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, par exemple avec une connexion OpenAI personnalisée) :
  - les autorités du magasin de certificats du système (autorités d'entreprise, antivirus qui inspectent HTTPS, certificats installés sur le poste) sont reconnues, comme dans la v1 ;
  - un serveur qui n'envoie pas son certificat intermédiaire est accepté comme dans un navigateur : l'intermédiaire indiqué par le certificat est téléchargé et vérifié, et il n'est retenu que s'il mène à une autorité reconnue ;
  - la vérification des certificats n'est jamais désactivée ; si le certificat reste refusé, le message explique la cause et la correction (chaîne complète côté serveur, ou autorité à installer sur le poste).

## 3.0.0-alpha.17 — 2026-10-28

- Release Windows uniquement (archive portable, installateur) et CLI : les paquets Linux ne sont pas publiés pour le moment.
- Paquet desktop : page d'accueil et dépôt renseignés (requis pour les paquets Linux, désormais construits sans erreur en CI).

## 3.0.0-alpha.16 — 2026-10-28

Première version publiée de la v3 (réécriture complète en TypeScript) ; l'ensemble des nouveautés depuis 3.0.0-alpha.1 est décrit dans les sections suivantes du [CHANGELOG](https://github.com/loicdelaunay/Monolith/blob/main/CHANGELOG.md).

- **Objectif de la discussion** : la fenêtre d'édition ne se referme plus aussitôt après son ouverture (menu « … », puce de l'objectif, commande /goal).
- **Mise à jour intégrée** : vérification de l'empreinte et extraction du paquet par .NET, indépendamment des modules PowerShell installés.
- Raccourcis affichés dans la langue de l'interface (Ctrl+Shift+M / Ctrl+Maj+M).
- **Sélection multiple des conversations** : Ctrl+clic pour ajouter ou retirer, Maj+clic pour une plage ; clic droit (ou barre de sélection) pour archiver ou supprimer toutes les conversations choisies ; Échap annule.
- **Fichiers dans le chat** : icône colorée selon le type de fichier ; clic droit sur un fichier cité ou sur le fichier d'une carte d'outil pour l'aperçu, l'ouverture avec l'application par défaut (jamais un exécutable), l'affichage dans le dossier ou la copie du chemin.
- **Barre latérale repliable** : bouton ☰ dans la barre de titre et raccourci Ctrl+B.
- **Outils dédiés dans leur propre fenêtre** : traducteur, images, assets, benchmark, détection IA et tableau de bord s'ouvrent chacun dans une fenêtre séparée (ramenée au premier plan si elle est déjà ouverte, fermée avec la fenêtre principale).
- **Vertex AI / Gemini 3 et suivants (dont Gemini 4)** : correction de l'erreur « Requests ending with a model turn are not supported » après une capture d'écran par un outil. Les images rendues par un outil sont désormais placées dans la réponse de fonction, comme l'exige Google ; chaque tour d'outils est rejoué séparément avec sa signature de réflexion ; les niveaux de réflexion de Gemini 4 sont reconnus.
- **Plan épinglé** : le plan de l'agent s'affiche au-dessus de la zone de saisie (dernière version, progression, repliable) au lieu de cartes répétées dans la conversation.
- **Sélecteur de modèle** : il reste ouvert après le choix d'un modèle (pour régler la réflexion juste après) et se ferme par un clic à l'extérieur.

## 3.0.0-alpha.15 — 2026-10-28

- **Première utilisation, comme la v1** : en choisissant le mode Automatique sans validateur, ou en activant le RAG sans embeddings, une fenêtre propose de **télécharger et utiliser le modèle local**, d'**utiliser un modèle spécifique** d'une connexion, ou d'**annuler** (rien ne change).
- **LANCET Nano (local)** valide les commandes du mode Automatique sur ce poste : une commande non signalée passe, une commande à vérifier ou risquée vous est soumise ; les autres actions suivent vos règles.
- **MiniLM multilingue (local)** calcule les embeddings du RAG sur ce poste, en français comme en anglais.
- Les modèles et leur environnement Python sont téléchargés uniquement après votre accord, chaque fichier vérifié par son empreinte ; progression et annulation dans la fenêtre et dans les réglages (Autorisations, Skills).
- **OpenAI Subscription** (comme la v1) : nouvelle connexion « OpenAI Subscription · ChatGPT Plus / Pro (Codex) » pour utiliser votre abonnement ChatGPT sans clé d'API. Cliquez sur « Connecter mon compte ChatGPT » et terminez la connexion OpenAI dans le navigateur ; les identifiants restent gérés par Codex et aucune clé d'API du poste n'est transmise. Node.js est requis.
- **Logos des fournisseurs** dans la liste des connexions et le sélecteur de modèle (OpenAI, DeepSeek, Gemini, Vertex AI, Mistral, Groq, NVIDIA, Z.ai, OpenRouter, Ollama, LM Studio, OpenCode, Gemini CLI, Claude Code).
- **Vertex AI · clé API Google Cloud de projet** (comme la v1) : nouvelle authentification « Clé API Google Cloud · projet » ; indiquez l'ID du projet (ex. `project-…`) et la région, puis collez la clé complète (points compris) dans le champ Clé. Elle est chiffrée et envoyée dans l'en-tête `x-goog-api-key`, jamais dans l'URL. Les identifiants de modèle `google/gemini-…` sont acceptés.

## 3.0.0-alpha.14 — 2026-10-28

Autorisations : modes Automatique et Autoriser tout (comme la v1).

- **Automatique** : chaque action qui n'est pas une simple lecture est analysée par un modèle validateur choisi dans Réglages › Autorisations. Un risque faible est accepté ; un risque moyen ou élevé, une réponse invalide, un délai dépassé ou l'absence de validateur demandent votre accord. Les accords enregistrés ne dispensent pas de l'analyse ; la consommation du validateur apparaît dans les statistiques.
- **⚠ Autoriser tout** : les actions sont acceptées sans analyse ; ce choix est signalé en orange sur l'icône des réglages rapides.
- Dans les deux modes, les règles Refuser et Demander s'appliquent toujours.
- Les cinq politiques sont proposées dans Réglages › Autorisations et dans les réglages rapides de la zone de saisie.

## 3.0.0-alpha.13 — 2026-10-27

Barre de saisie allégée.

- **Utilisation du contexte** : une jauge circulaire remplace le texte ; le détail (utilisé, fenêtre du modèle, restant, sortie maximale, compactages, source des compteurs) s'ouvre au survol ou au focus clavier.
- **Réglages rapides** : une icône à droite du « + » ouvre le choix du mode (Chat, Agent Plan / Proposition / Exécution), la politique d'autorisation et l'activation des skills.
- **Réflexion** : le niveau se choisit dans le sélecteur de modèle (affiché à côté du modèle quand il n'est pas sur Auto).
- Éléments de la barre légèrement abaissés ; le bouton d'envoi ne bouge pas.

## 3.0.0-alpha.12 — 2026-10-27

Tranche T14 : distribution et validation.

- **Mises à jour vérifiées** (Réglages › À propos) : vérification des versions publiées sur GitHub (désactivée, signaler — par défaut — ou télécharger et installer à la fermeture), téléchargement vérifié par l'empreinte SHA-256 publiée, sauvegarde de la base avant l'installation, ancienne version conservée et restaurée en cas d'échec. Installation automatique pour la version portable Windows ; signalement seulement pour l'installateur et Linux.
- **Paquets Windows** : archive portable (zip) et installateur, avec SHA256SUMS ; contrôle qu'aucune donnée utilisateur n'est incluse.
- **Accessibilité** : contraste des boutons corrigé (texte lisible sur les boutons principaux et secondaires), noms accessibles du numéro de version, des projets, du bouton Ressources et des listes déroulantes. Audit automatique WCAG 2.1 AA sans violation sur les vues contrôlées.
- **Contrôle qualité reproductible** : `npm run quality` (audit d'accessibilité et mesures de performance sur la fenêtre réelle).
- Workflow de release : chemins des paquets corrigés (toujours manuel, brouillon seulement sur demande).

## 3.0.0-alpha.11 — 2026-10-27

Tranche T11 : contrôle du bureau Windows.

- **Contrôle du clavier** et **contrôle de la souris** (Réglages › Skills, désactivés par défaut) : l'IA liste les fenêtres, inspecte l'arbre des contrôles (identifiants opaques valables 10 minutes) puis agit par **UI Automation**, sans déplacer le curseur ni simuler de touches : saisir ou remplacer une valeur, invoquer, cocher, sélectionner, dérouler, faire défiler.
- **Modes séparés** pour le clavier et la souris : Automatique (UI Automation d'abord), UI Automation seule, ou Legacy (saisie physique : raccourcis, double clic, clic droit, coordonnées). « Autoriser l'IA à choisir le mode » est actif par défaut ; un mode fixe n'est jamais contourné.
- **Repli Legacy** désactivé par défaut ; activé, il n'intervient que si UI Automation n'expose pas l'action, avant toute modification, et demande une autorisation distincte. Aucune relance après un échec ou un délai dépassé.
- Chaque résultat indique le **mode réellement utilisé** et la **raison d'un repli**. Les accords permanents distinguent UI Automation et Legacy. Les fenêtres de Monolith ne peuvent pas être contrôlées par l'IA.
- Capacités par système mises à jour (Réglages › À propos) : macOS et Linux déclarés non pris en charge pour le contrôle du clavier et de la souris.

## 3.0.0-alpha.10 — 2026-10-27

Tranche T10 : modèles locaux.

- **Modèles locaux** (Réglages › Modèles locaux) : matériel détecté (mémoire, processeur, VRAM des GPU NVIDIA), catalogue Hugging Face des modèles GGUF avec quantification et estimation de la mémoire nécessaire (poids, contexte, couches sur le GPU), téléchargements reprenables vérifiés par empreinte SHA-256, jeton chiffré pour les modèles protégés, import de fichiers .gguf.
- **Moteur llama.cpp** : chemin d'un `llama-server` existant (vérifié) ou installation de la version officielle (CPU, CUDA, Vulkan) vérifiée par son empreinte publiée ; le serveur démarre à la demande sur 127.0.0.1 avec le contexte et les couches GPU choisis (ou estimés), puis s'arrête après inactivité.
- Fournisseur **« Modèles locaux »** : les modèles installés apparaissent dans le sélecteur du chat.
- **CLI** : développement reporté (voir `cli-todo.md`) ; le CLI existant reste disponible.

## 3.0.0-alpha.9 — 2026-10-27

Tranche T9 : suivi, maintenance et confort. Client HTTP intégré.

- **Client HTTP intégré (comme la v1)** pour la recherche web : requêtes sans navigateur, mode Smart (réponse enregistrée, plan et aperçu, puis recherche et lecture ciblées), mode Legacy, cookies, user-agent, proxy, redirections et délai réglables (Réglages › Skills › Web, et par conversation par l'agent). La recherche DuckDuckGo passe par ce client ; un réglage « aucun moteur » réserve le web au client HTTP.
- **Tableau de bord** (menu Outils) : consommation par jour, modèle et usage, filtres, export CSV.
- **Tâches planifiées** (Réglages) : CRON avec fuseau horaire, aperçu des prochaines échéances, exécution immédiate, historique, notification ; exécutées tant que l'application est ouverte.
- **Notifications** : cloche (non lues, ouverture de la conversation), notifications système et son, au choix ; fin de réponse en arrière-plan, tâches planifiées, erreurs.
- **Avancé** : accélération matérielle, moteur de rendu, synchronisation verticale (au prochain démarrage) et valeurs réellement utilisées ; diagnostics (processus, mémoire, CPU, stockage, journaux) et export expurgé ; sauvegardes et restauration ; maintenance automatique (archivage, suppression, pièces jointes orphelines).
- **Apparence** : nom et logos personnalisés (clair/sombre), animations de fond facultatives.
- **Serveur** : développement reporté (voir `server-todo.md`).

## 3.0.0-alpha.8 — 2026-10-27

Tranche T8 : outils dédiés.

- **Menu Outils** (bas de la barre latérale) ouvrant l'atelier :
  - **Traducteur et correcteur** : traduire, corriger (avec diff des corrections) ou réécrire, ton et consignes, modèle au choix.
  - **Images et vision** : génération d'images (connexions compatibles OpenAI ou Gemini) ; **vision de secours** : quand le modèle de la conversation n'accepte pas les images, elles sont décrites une fois par un modèle de vision puis transmises en texte.
  - **Assets** : SVG (animations comprises) et pixel art animé, import SVG, export SVG et PNG à l'échelle ; aussi dans l'onglet Assets du panneau de travail.
  - **Benchmark** : plusieurs modèles comparés en parallèle (premier token, durée, tokens/s, réponse attendue), répétitions, annulation.
  - **Détection de contenu IA** : indicateurs stylistiques et avis facultatif d'un modèle, présentés comme indicatifs avec un avertissement explicite.
- Outils de l'agent : generate_image, describe_image, asset_create / list / read / export.

## 3.0.0-alpha.7 — 2026-10-27

Tranche T7 : orchestration.

- **Sous-agents** : l'agent confie des sous-tâches indépendantes à des sous-agents exécutés en parallèle, chacun dans sa propre conversation (consultable depuis la bulle), avec un rôle (Explorateur, Implémenteur, Relecteur ou les vôtres), un budget (tours, tokens, délai) et un mode jamais plus permissif que celui de la conversation. Suivi en direct, rapports, annulation propagée. Réglages › Agents : délégation automatique, encouragée ou désactivée, profondeur, parallélisme, budgets, rôles.
- **Worktrees Git** : un sous-agent peut travailler sur une branche et un worktree dédiés ; suppression du worktree depuis la bulle (branche conservée).
- **Sandbox** (menu de la conversation) : les ressources sont remplacées par des copies privées ; diff par fichier, application sélective aux originaux avec détection des conflits, abandon qui rétablit les ressources.
- **Build de test** : un seul dossier `artifacts/GUI` avec `Monolith.exe`, remplacé à chaque build ; vos données de test (`data/`) sont conservées.
- CLI : `/subagents`, `/sandbox`.

## 3.0.0-alpha.6 — 2026-10-27

Tranche T6 : mémoire, index, RAG, skills, MCP et web. Nouvelle zone de saisie.

- **Zone de saisie** repensée : bouton « + » (pièces jointes, modèles de messages), mode en un clic, sélecteur unique Fournisseur / Modèle à deux colonnes avec recherche, réflexion, bouton d'envoi rond ; utilisation du contexte (avec pourcentage) et vitesse (en direct pendant la génération, mesurée ensuite) affichées par défaut.
- **Mémoire** : portées conversation, projet, générale et utilisateur, versions et provenance ; outils de l'agent (chercher, lire, enregistrer, supprimer) ; Réglages › Mémoire (recherche, filtre, tri, pagination, édition, versions) ; lecture initiale forcée et écriture forcée, désactivées par défaut.
- **Index de fichiers `index.ohm`** : inventaire portable avec résumés et explications, rapproché à chaque lecture ; une explication dont le fichier a changé est marquée à revoir.
- **RAG** : indexation des ressources de la conversation (incrémentale, annulable), recherche lexicale et, si une connexion d'embeddings est choisie, vectorielle ; fichiers modifiés depuis l'indexation signalés (bouton Ressources).
- **Web** : recherche (DuckDuckGo ou votre instance SearXNG), lecture de pages et requêtes d'API ; adresses privées refusées à chaque redirection.
- **Skills personnalisés `SKILL.md`** : globaux ou de projet, listés dans les instructions, chargés à la demande, créables par l'agent.
- **MCP** : serveurs stdio et HTTP, import JSON prévisualisé (secrets chiffrés), connexion, découverte des outils, activation par conversation (bouton Ressources), `/mcp` dans le CLI.
- **Python** : exécution de scripts avec le Python 3 du poste.

## 3.0.0-alpha.5 — 2026-10-27

Tranche T5 : fournisseurs étendus.

- **Gemini natif** (Google AI Studio) : flux natif, instructions système, outils, images, réflexion adaptée à la génération du modèle (budget pour 2.5, niveau pour 3) avec pensées affichées, signatures de réflexion conservées et renvoyées lors des appels d'outils, catalogue de modèles.
- **Vertex AI** : clé en mode Express, identifiants par défaut de gcloud (ADC) ou compte de service (JSON chiffré comme une clé, jeton signé localement), projet et région configurables.
- **Agents externes ACP** : OpenCode, Gemini CLI, Claude Code ou tout agent compatible, lancé sur ce poste dans le dossier de la conversation. Réflexion, plan et actions de l'agent affichés dans la réponse ; ses demandes d'autorisation passent par vos règles et par le mode de la conversation ; il ne lit et n'écrit des fichiers que dans les ressources de la conversation.
- **Modèles composés** : un orchestrateur consulte des spécialistes (autres connexions et modèles) ; chaque consultation est affichée et comptée dans la consommation.
- **Raccourcis** : Ctrl+Maj+M (mode suivant), Ctrl+Maj+R (niveau de réflexion suivant) et raccourcis personnalisés appliquant fournisseur, modèle, mode et réflexion (Réglages › Raccourcis) ; CLI : `/shortcut` et Alt+chiffre.

## 3.0.0-alpha.4 — 2026-10-27

Tranche T4 : panneaux de travail, Git, navigateur intégré et rendu enrichi.

- **Panneau de travail** (Ctrl+J ou bouton de l'en-tête) : onglets Fichiers, Terminal, Git, Navigateur et Aperçu ; redimensionnable, agrandissable, fermable ; onglet, largeur et état conservés.
- **Fichiers** : arborescence limitée aux ressources de la conversation, recherche par nom ou dans le contenu, copie du chemin, affichage dans l'explorateur ; **Aperçu** rendu ou source (Markdown, HTML isolé, SVG, images, code coloré).
- **Terminal** : commandes de la conversation (agent et vous), sortie en direct, arrêt, nouvelle commande dans le dossier de la conversation.
- **Git** : statut, diff par fichier, indexer, désindexer, annuler (avec confirmation), commit, changement de branche, historique, fetch, pull, push (avec confirmation). Outils Git pour l'agent : lecture automatique, écritures et accès réseau soumis aux autorisations.
- **Navigateur intégré** : onglets, adresse ou recherche, navigation, vue mobile, outils de développement, ouverture dans le navigateur système, effacement des données. Partition isolée, aucune permission web, téléchargements bloqués. L'agent peut ouvrir une page publique, lire son texte, inspecter le DOM, cliquer et saisir (jamais dans un champ mot de passe) ; les adresses privées et locales lui sont refusées.
- **Captures** (skill désactivé par défaut) : page du navigateur, écran ou fenêtre, jointes à la conversation et transmises aux modèles avec vision.
- **Rendu enrichi** (Réglages › Chat) : formules LaTeX (KaTeX), diagrammes Mermaid, aperçus isolés des blocs HTML et SVG (scripts désactivés), badges pour les fichiers cités vérifiés sur le disque (clic = aperçu).

## 3.0.0-alpha.3 — 2026-10-27

Tranche T3 : outils, modes Agent et autorisations.

- **Modes** : Chat (conversation, sans accès aux fichiers) et Agent en trois modes appliqués par le moteur, pas seulement par les instructions : **Plan** (lecture seule), **Proposition** (changements de fichiers enregistrés, appliqués ou rejetés par vous, avec détection de conflit si le fichier a changé), **Exécution**.
- **Outils** : lister, lire (plages de lignes), glob, grep, écrire, modifier, patch multi-fichiers atomique (tout ou rien), commandes asynchrones avec délai et code de retour, informations (date, système, conversation, réglables), questions interactives, propositions d'actions, plan de travail. Chaque skill est activable individuellement (Réglages › Skills) ; l'activer n'accorde aucune autorisation.
- **Autorisations** : politiques Refuser tout / Demander / Selon les règles, règles par outil, famille, ressource (motifs glob) et portée (globale, projet, conversation), refus explicite toujours prioritaire, historique des décisions. La demande présente l'action, la cible, la raison, les paramètres et le diff des changements attendus. Une annulation ne vaut jamais approbation. Import prévisualisé d'un `permission.json` par projet.
- **Bouclier** dans chaque bulle d'outil : origine de la décision (règle, réponse, politique, mode, lecture automatique), portée et motif. Paramètres en vue **Formatée** (diff ligne par ligne et par bloc : ajouts verts, suppressions rouges, remplacements orange avec avant/après et numéros de ligne, calcul hors du thread d'interface pour les gros fichiers) ou **Brute** (JSON original).
- **Ressources** : héritées du projet ou propres à la conversation (dossiers et fichiers isolés), retour aux ressources du projet ; un fichier joint n'ouvre jamais son dossier ; une conversation sans dossier dispose d'un espace privé persistant. Les chemins sont canonisés : `..`, liens symboliques et jonctions ne permettent pas de sortir de la portée ; la base, les clés et les journaux de l'application restent inaccessibles.
- **Fichiers d'instructions** (`AGENTS.md`, `CLAUDE.md`, `.monolith/instructions.md`) des dossiers et sous-dossiers, transmis avec leur portée explicite.
- **Questions interactives** : tuiles adaptées au thème, choix unique par défaut, choix multiple seulement sur demande, texte libre ou réponse personnalisée, accordéon récapitulatif et navigation précédente/suivante.
- **Propositions d'actions** (continuer ici, agent dans une nouvelle discussion, nouvelle discussion, file d'attente) : consigne consultable, rien ne démarre avant le clic, une seule utilisation, aucune permission supplémentaire.
- **Détection de boucle** : seuil, fenêtre et comparaison (exacte ou équivalente) réglables ; arrêter ou poursuivre une fois, sans toucher aux autres conversations.
- **Fiabilité** : un outil déjà exécuté n'est jamais rejoué ; un appel en cours lors d'une fermeture est marqué « interrompu » (effet incertain) ; le résultat renvoyé au modèle est toujours fidèle (refus, erreur, annulation).
- **CLI** : demandes d'autorisation, questions et boucles au clavier, `/mode`, `/resources`, `/rules`, `/allow`, `/deny`, `/unrule`, `/proposals`, `/apply`, `/reject` ; en mode non interactif (`-p`), toute demande d'autorisation est refusée explicitement.

## 3.0.0-alpha.2 — 2026-10-27

Tranche T2 : conversation avancée.

- **File d'attente** : pendant une génération, Entrée met le message en file ; il part automatiquement à la fin, avec la configuration du moment. La file est visible au-dessus de l'éditeur : modification, suppression et réordonnancement. Après une annulation ou une erreur, elle se met en pause et reprend avec « Envoyer le suivant ».
- **Instructions pendant la génération** (Alt+Entrée, bouton éclair, `/steer` en CLI) : ajoutées à l'historique à la fin du tour en cours, puis le modèle reprend avec la même configuration. Les messages indiquent leur origine.
- **Reprendre ici** : replace le texte et les pièces jointes d'un de vos messages dans l'éditeur ; l'historique complet est d'abord sauvegardé dans une conversation archivée.
- **Bifurcation et duplication** depuis n'importe quel message ou depuis le menu de la conversation, avec un lien vers la conversation d'origine.
- **Export Markdown** (avec ou sans la réflexion) vers un fichier choisi ; le CLI n'écrase jamais un fichier existant.
- **Pièces jointes** : images PNG, JPEG, WebP, GIF (≤ 10 Mo) et fichiers texte UTF-8 (≤ 1 Mo), par bouton, glisser-déposer ou collage, vérifiées d'après leur contenu réel. Les images ne sont envoyées qu'aux modèles qui les acceptent ; sinon elles sont retirées avec un avertissement. PDF et documents bureautiques : pas encore pris en charge (refus expliqué).
- **Modèles de messages** réutilisables, objectif persistant par discussion, commandes « / » dans l'éditeur (`/compact`, `/export`, `/fork`, `/goal`, `/template`).
- **Nommage automatique** après la première réponse, par une requête dédiée (connexion et modèle configurables), comptabilisée séparément ; un titre choisi par vous n'est jamais remplacé.
- **Réflexion** : seuls les niveaux documentés (table de modèles connus, catalogue OpenRouter) ou déclarés par vous sont proposés, Auto seul sinon. Chaque réponse indique le niveau demandé, le niveau envoyé, le paramètre utilisé et l'éventuel repli. Un niveau refusé par le fournisseur est retiré jusqu'à « Actualiser les capacités ». « Sans réflexion » n'est jamais remplacé en silence : l'incompatibilité est signalée.
- **Contexte** : fenêtre de contexte et limite de sortie modifiables par modèle, utilisation du contexte affichable dans l'éditeur, compactage manuel et automatique avant envoi (seuil et nombre d'échanges conservés réglables). L'historique affiché reste complet, avec un repère « contexte compacté ici ».
- **Longues conversations** : rendu différé des messages hors écran et chargement des anciens messages à la demande, sans perte de position.
- **CLI** : `/queue`, `/unqueue`, `/next`, `/steer`, `/history`, `/resume`, `/fork`, `/export`, `/goal`, `/compact`, `/context`, `/templates`, `/template`, `/attach`, `/detach`, `/reasoning`.

## 3.0.0-alpha.1 — 2026-10-27

Première tranche de la réécriture complète (Electron + Vue 3 + PrimeVue, moteur TypeScript partagé, SQLite intégré).

- **Projets** : création, modification (nom, icône, couleur, instructions), plusieurs dossiers sources, réorganisation par glisser-déposer, suppression avec choix de conserver ou supprimer les conversations. Les dossiers sur disque ne sont jamais modifiés.
- **Conversations** : espace personnel et projets, création, renommage en ligne, favoris, épinglage, archivage, déplacement entre projets, réorganisation, suppression avec confirmation, recherche dans les titres et les messages, brouillon conservé par conversation.
- **Chat** : réponses en streaming robuste (fragments, coupures UTF-8, CRLF), arrêt de la génération, plusieurs conversations en parallèle, instantané de configuration figé par génération, Markdown avec tableaux et code coloré (copie, numéros de ligne), réflexion affichée selon le réglage Aucun / Réduit / Détaillé, compteurs de tokens fournis par l'API ou estimation signalée, débit optionnel.
- **Fiabilité** : nouvelles tentatives configurables uniquement pour les erreurs transitoires et pour le cas ciblé « HTTP 400 JSON tronqué par une passerelle » ; une génération coupée par une fermeture est marquée « Interrompu » au redémarrage, contenu partiel conservé.
- **Fournisseurs** : connexions compatibles OpenAI (OpenAI, DeepSeek, OpenRouter, Google AI Studio, Groq, Mistral, NVIDIA, Z.ai, Ollama, LM Studio, llama.cpp, personnalisé), écran liste/détail, clé chiffrée et masquée avec remplacement explicite, test de connexion affiché sous le bouton, import du catalogue, recherche, sélection et pagination des modèles, ajout manuel. Les types non encore disponibles (Gemini natif, Vertex AI, OpenCode, ACP, modèles composés, GGUF intégré) sont affichés comme tels avec leur échéance.
- **Réglages** : navigation recherchable, Général, Chat, Apparence, Fournisseurs, Réinitialisation et À propos ; les sections prévues indiquent leur tranche. Annuler restaure l'état initial, y compris l'aperçu d'apparence.
- **Apparence** : modes clair / sombre / système, thèmes Monolith, Fluent sombre V2 (accent #1D6FC8) et Graphite, accent, polices, taille de lecture, densité, zoom, couleurs des messages, barre de titre intégrée ou cadre système.
- **Données** : dossier portable à côté de l'exécutable lorsqu'il est inscriptible, emplacement alternatif configurable, migrations vérifiées avec sauvegarde automatique, clés protégées par DPAPI (Windows) ou Secret Service (Linux).
- **CLI** : conversations en streaming dans le terminal avec le même moteur.
