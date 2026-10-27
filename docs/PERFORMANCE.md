# Mesures de performances

Chaque mesure indique ses conditions. Elles décrivent la configuration de référence, pas une garantie sur tous les systèmes. Protocole reproductible : `npm run build` puis `npm run quality` (voir plus bas).

## 2026-10-27 — 3.0.0-alpha.12, protocole `npm run quality`

Conditions : Windows 11 Pro 26200, RTX 3090, 64 Go ; bundles de production (`npm run build`) lancés par Electron, profil de démonstration neuf avec une conversation de 300 messages (Markdown, code, tableaux), thème sombre, fenêtre 1600 × 1028. Trois exécutions consécutives.

| Mesure | Valeur | Remarques |
| --- | --- | --- |
| Lancement → début du chargement de la fenêtre | 1,05 à 1,07 s | Depuis le lancement de la commande (`npx electron`, démarrage du moteur compris). |
| DOM prêt (depuis le début du chargement) | 87 à 95 ms | |
| Ouverture de la conversation de 300 messages | 94 à 128 ms | Clic → messages affichés (2 images) ; 80 messages rendus (fenêtrage). |
| Tas JavaScript de l'interface | 51 à 54 Mo | Après l'ouverture de la conversation et des réglages. |
| Nœuds DOM | ≈ 3 100 | |

Limites : une seule configuration ; pas de mesure du défilement continu ni de comparaison Linux ; le tas JS n'inclut ni le moteur ni le processus principal.

## 2026-10-27 — 3.0.0-alpha.1, build Windows empaqueté

Conditions : Windows 11 Pro 26200, build `electron-builder --win dir` (Electron 44.9.3), profil vide dans un dossier temporaire, fenêtre affichée sans interaction, thème sombre système. Mesure par `Get-Process` (temps CPU cumulé et mémoire) sur les 5 processus de l'application, après 8 s de stabilisation.

| Mesure | Valeur | Remarques |
| --- | --- | --- |
| CPU au repos sur 20 s | 0,000 s cumulés | Résolution de l'horloge des processus Windows ≈ 15 ms : aucun réveil mesurable. Aucune boucle d'attente, aucun minuteur périodique. |
| Mémoire de travail totale | ≈ 405 Mo | Principal, rendu, GPU, service réseau et moteur (`utilityProcess`). |
| Mémoire privée totale | ≈ 229 Mo | |

Limites : pas encore de mesure du temps de démarrage instrumentée, du défilement de longues conversations (virtualisation prévue en T2) ni de comparaison Linux. Le bundle principal de l'interface (≈ 1,6 Mo) n'est pas encore découpé ; les grammaires de coloration sont chargées à la demande.
