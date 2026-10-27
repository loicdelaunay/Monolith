# Serveur Monolith Harness — reporté

Le développement du serveur (ancienne tranche **T13**) est **reporté à plus tard**, à la demande de l'utilisateur (2026-10-27). Rien de ce qui suit n'est implémenté : la colonne « Serveur » de `docs/FEATURE-MATRIX.md` reste à ⬜ / reporté.

## Ce qui est déjà prêt côté moteur

- Le moteur (`packages/core`) est indépendant de l'hôte : toute la logique (conversations, fournisseurs, outils, autorisations, mémoire, MCP, sous-agents, planificateur…) est déjà utilisable par un serveur.
- Le contrat d'API (`packages/contracts/src/api.ts` : `HarnessApi`, `HarnessEvents`) et le client RPC (`rpc-client.ts`) sont communs aux hôtes ; un transport HTTP + WebSocket n'a qu'à implémenter `RpcPort` (`packages/core/src/rpc/port.ts`).
- Les outils déclarent déjà leurs hôtes (`desktop`, `cli`, `server`) : le navigateur intégré et les captures sont automatiquement indisponibles sans hôte graphique.
- Le planificateur exécute déjà les tâches tant que le processus tourne : sur un serveur, elles fonctionneront sans client ouvert.

## Périmètre à développer

| Réf. | Fonctionnalité | Notes de conception |
| --- | --- | --- |
| V-01 | Admin web, API documentée, temps réel | Processus Node autonome (`apps/server`), API REST décrite en OpenAPI, WebSocket pour les événements (`HarnessEvents`), admin web en Vue + PrimeVue 4 (même design system que le desktop). |
| V-02 | Comptes, rôles, permissions, projets par utilisateur/rôle | Comptes locaux (mots de passe hachés Argon2id ou scrypt), sessions par jeton, rôles (admin, membre, invité), projets attribués par utilisateur ou par rôle ; les règles d'autorisation d'outils existantes s'appliquent par-dessus. |
| V-03 | Fournisseurs partagés, clés côté serveur | Connexions définies par l'admin, clés chiffrées côté serveur (jamais renvoyées aux clients), quotas éventuels par utilisateur. |
| V-04 | Exécution cloud, files, simultanéité | Espaces de projet côté serveur, file d'exécution, limites de générations simultanées par utilisateur et globales, annulation. |
| V-05 | Tâches planifiées sans client | Réutiliser `SchedulerService` ; propriétaire et projet par tâche ; notifications aux clients connectés. |
| V-06 | Partage en direct local, commentaires, révocation | Lien de partage d'une conversation (lecture seule ou commentaires), relayé par le serveur, révocable, expirable. |
| V-07 | Synchronisation cloud → clients | Les desktop/CLI peuvent se connecter au serveur (transport RPC distant) ; conflits gérés par le serveur (source de vérité). |
| V-08 | Statistiques partagées sur consentement, audit, message admin | Agrégats de consommation (consentement explicite), journal d'audit (connexions, changements de droits, accès aux secrets), message d'information de l'admin affiché aux clients. |
| V-09 | Service système, redémarrage après panne, mise à jour et sauvegarde documentées | Service systemd et service Windows, redémarrage automatique, sauvegarde/restauration (réutiliser `BackupService`), procédure de mise à jour documentée ; exécutable autonome (Node SEA). |

## Exigences à respecter le moment venu

- Sécurité : HTTPS obligatoire hors `localhost`, CORS strict, limitation de débit, aucune clé ni secret dans les journaux, exports ou captures.
- Les garde-fous du moteur restent actifs côté serveur : portée des fichiers, garde SSRF, autorisations, modes Agent.
- Aucune publication distante sans demande explicite de l'utilisateur.
- Tests : intégration HTTP + WebSocket, droits par rôle, partage révoqué, reprise après redémarrage.
