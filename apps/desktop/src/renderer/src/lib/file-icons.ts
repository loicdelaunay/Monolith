/** Icône et couleur d'un fichier selon son extension (badges du chat, cartes d'outils). */
export interface FileIcon {
  icon: string;
  color: string;
}

const CODE = 'pi-code';
const BY_EXT: Record<string, FileIcon> = {
  ts: { icon: CODE, color: '#3178c6' },
  tsx: { icon: CODE, color: '#3178c6' },
  mts: { icon: CODE, color: '#3178c6' },
  js: { icon: CODE, color: '#e5c100' },
  jsx: { icon: CODE, color: '#e5c100' },
  mjs: { icon: CODE, color: '#e5c100' },
  cjs: { icon: CODE, color: '#e5c100' },
  vue: { icon: CODE, color: '#41b883' },
  svelte: { icon: CODE, color: '#ff3e00' },
  py: { icon: CODE, color: '#3776ab' },
  rs: { icon: CODE, color: '#dea584' },
  go: { icon: CODE, color: '#00add8' },
  java: { icon: CODE, color: '#b07219' },
  kt: { icon: CODE, color: '#a97bff' },
  cs: { icon: CODE, color: '#68217a' },
  c: { icon: CODE, color: '#659ad2' },
  h: { icon: CODE, color: '#659ad2' },
  cpp: { icon: CODE, color: '#f34b7d' },
  hpp: { icon: CODE, color: '#f34b7d' },
  php: { icon: CODE, color: '#777bb4' },
  rb: { icon: CODE, color: '#cc342d' },
  swift: { icon: CODE, color: '#f05138' },
  dart: { icon: CODE, color: '#0175c2' },
  gd: { icon: CODE, color: '#478cbf' },
  lua: { icon: CODE, color: '#000080' },
  sh: { icon: 'pi-angle-double-right', color: '#89e051' },
  bash: { icon: 'pi-angle-double-right', color: '#89e051' },
  ps1: { icon: 'pi-angle-double-right', color: '#5391fe' },
  bat: { icon: 'pi-angle-double-right', color: '#c1f12e' },
  cmd: { icon: 'pi-angle-double-right', color: '#c1f12e' },
  html: { icon: 'pi-globe', color: '#e34c26' },
  htm: { icon: 'pi-globe', color: '#e34c26' },
  css: { icon: 'pi-palette', color: '#663399' },
  scss: { icon: 'pi-palette', color: '#c6538c' },
  less: { icon: 'pi-palette', color: '#1d365d' },
  json: { icon: 'pi-code', color: '#cbcb41' },
  jsonc: { icon: 'pi-code', color: '#cbcb41' },
  yml: { icon: 'pi-cog', color: '#cb171e' },
  yaml: { icon: 'pi-cog', color: '#cb171e' },
  toml: { icon: 'pi-cog', color: '#9c4221' },
  ini: { icon: 'pi-cog', color: '#8a8a8a' },
  env: { icon: 'pi-cog', color: '#ecd53f' },
  xml: { icon: 'pi-code', color: '#0060ac' },
  md: { icon: 'pi-file-edit', color: '#519aba' },
  mdx: { icon: 'pi-file-edit', color: '#519aba' },
  txt: { icon: 'pi-file', color: '#8a8a8a' },
  log: { icon: 'pi-list', color: '#8a8a8a' },
  csv: { icon: 'pi-file-excel', color: '#217346' },
  tsv: { icon: 'pi-file-excel', color: '#217346' },
  xlsx: { icon: 'pi-file-excel', color: '#217346' },
  xls: { icon: 'pi-file-excel', color: '#217346' },
  docx: { icon: 'pi-file-word', color: '#2b579a' },
  doc: { icon: 'pi-file-word', color: '#2b579a' },
  pdf: { icon: 'pi-file-pdf', color: '#e5252a' },
  png: { icon: 'pi-image', color: '#a074c4' },
  jpg: { icon: 'pi-image', color: '#a074c4' },
  jpeg: { icon: 'pi-image', color: '#a074c4' },
  gif: { icon: 'pi-image', color: '#a074c4' },
  webp: { icon: 'pi-image', color: '#a074c4' },
  svg: { icon: 'pi-image', color: '#ffb13b' },
  ico: { icon: 'pi-image', color: '#a074c4' },
  mp3: { icon: 'pi-volume-up', color: '#d4843e' },
  wav: { icon: 'pi-volume-up', color: '#d4843e' },
  mp4: { icon: 'pi-video', color: '#d4843e' },
  webm: { icon: 'pi-video', color: '#d4843e' },
  zip: { icon: 'pi-box', color: '#b8860b' },
  gz: { icon: 'pi-box', color: '#b8860b' },
  '7z': { icon: 'pi-box', color: '#b8860b' },
  sql: { icon: 'pi-database', color: '#e38c00' },
  sqlite: { icon: 'pi-database', color: '#0f80cc' },
  db: { icon: 'pi-database', color: '#0f80cc' },
  lock: { icon: 'pi-lock', color: '#8a8a8a' },
  exe: { icon: 'pi-cog', color: '#8a8a8a' },
};
const BY_NAME: Record<string, FileIcon> = {
  dockerfile: { icon: 'pi-box', color: '#2496ed' },
  makefile: { icon: 'pi-cog', color: '#6d8086' },
  '.gitignore': { icon: 'pi-github', color: '#f05032' },
  'package.json': { icon: 'pi-box', color: '#cb3837' },
  'index.ohm': { icon: 'pi-sitemap', color: '#8183f4' },
};

export function fileIcon(path: string, type: 'file' | 'directory' | string = 'file'): FileIcon {
  if (type === 'directory') return { icon: 'pi-folder', color: '#dcb67a' };
  const name = path.split(/[\\/]/).pop()?.toLowerCase() ?? '';
  if (BY_NAME[name]) return BY_NAME[name];
  const ext = name.includes('.') ? name.split('.').pop()! : '';
  return BY_EXT[ext] ?? { icon: 'pi-file', color: 'var(--mh-muted)' };
}

/** Extensions jamais ouvertes par « Ouvrir » (exécution possible) : seul « Afficher dans le dossier » reste. */
export const EXECUTABLE_EXTENSIONS = new Set(['exe', 'bat', 'cmd', 'com', 'msi', 'ps1', 'psm1', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'scr', 'lnk', 'url', 'reg', 'hta', 'cpl', 'jar', 'sh', 'app', 'appimage', 'deb', 'rpm', 'dll', 'sys', 'pif', 'application', 'gadget', 'msc', 'msp', 'scf', 'inf']);

export function isExecutable(path: string): boolean {
  const ext = path.split(/[\\/]/).pop()?.toLowerCase().split('.').pop() ?? '';
  return EXECUTABLE_EXTENSIONS.has(ext);
}
