# Changelog

Toutes les modifications visibles sont listées ici, de la plus récente à la plus ancienne. Versions alignées pour l'interface desktop, le CLI et le serveur.

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
