/**
 * Neutralise les séquences de contrôle terminal dans un contenu non fiable (réponses du modèle,
 * titres, noms de fichiers…) avant affichage : CSI, OSC (liens, titre de fenêtre, presse-papiers),
 * DCS/APC/PM/SOS, ESC isolés et caractères C0/C1. Seuls `\n` et `\t` sont conservés ; `\r` isolé
 * (réécriture de ligne) est supprimé.
 */
// eslint-disable-next-line no-control-regex
const SEQUENCES = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][\s\S]*?(?:\u0007|\u001b\\|$)|\u001b[PX^_][\s\S]*?(?:\u001b\\|$)|\u009b[0-?]*[ -/]*[@-~]|\u009d[\s\S]*?(?:\u0007|\u009c|$)|\u001b[@-Z\\-_]?/g;
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

export function sanitize(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(SEQUENCES, '').replace(/\r/g, '').replace(CONTROLS, '');
}
