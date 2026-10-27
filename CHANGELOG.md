# Changelog

Toutes les modifications visibles sont listées ici, de la plus récente à la plus ancienne. Versions alignées pour l'interface desktop, le CLI et le serveur.

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
