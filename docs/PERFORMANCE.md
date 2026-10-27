# Mesures de performances

Chaque mesure indique ses conditions. Elles décrivent la configuration de référence, pas une garantie sur tous les systèmes. Un protocole reproductible (scripts, répétitions, défilement, réveils) est prévu en tranche T14.

## 2026-10-27 — 3.0.0-alpha.1, build Windows empaqueté

Conditions : Windows 11 Pro 26200, build `electron-builder --win dir` (Electron 44.9.3), profil vide dans un dossier temporaire, fenêtre affichée sans interaction, thème sombre système. Mesure par `Get-Process` (temps CPU cumulé et mémoire) sur les 5 processus de l'application, après 8 s de stabilisation.

| Mesure | Valeur | Remarques |
| --- | --- | --- |
| CPU au repos sur 20 s | 0,000 s cumulés | Résolution de l'horloge des processus Windows ≈ 15 ms : aucun réveil mesurable. Aucune boucle d'attente, aucun minuteur périodique. |
| Mémoire de travail totale | ≈ 405 Mo | Principal, rendu, GPU, service réseau et moteur (`utilityProcess`). |
| Mémoire privée totale | ≈ 229 Mo | |

Limites : pas encore de mesure du temps de démarrage instrumentée, du défilement de longues conversations (virtualisation prévue en T2) ni de comparaison Linux. Le bundle principal de l'interface (≈ 1,6 Mo) n'est pas encore découpé ; les grammaires de coloration sont chargées à la demande.
