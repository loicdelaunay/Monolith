/** Thèmes du terminal (couleurs nommées ou hexadécimales, dégradées automatiquement par Ink/chalk). */
export interface CliTheme {
  id: string;
  accent: string;
  user: string;
  assistant: string;
  muted: string;
  reasoning: string;
  error: string;
  warning: string;
  success: string;
  border: string;
  code: string;
}

export const CLI_THEMES: CliTheme[] = [
  { id: 'monolith', accent: '#8183f4', user: '#c9cafc', assistant: 'white', muted: 'gray', reasoning: 'gray', error: '#f06a6a', warning: '#e0a43a', success: '#4cc38a', border: 'gray', code: '#a5d6ff' },
  { id: 'fluent', accent: '#1D6FC8', user: '#9cc7f2', assistant: 'white', muted: 'gray', reasoning: 'gray', error: '#ff6b5b', warning: '#fce100', success: '#6ccb5f', border: '#3a3a3a', code: '#9cdcfe' },
  { id: 'crt-green', accent: '#33ff66', user: '#a8ffb8', assistant: '#33ff66', muted: '#1f9e40', reasoning: '#1f9e40', error: '#ff5555', warning: '#d7ff5f', success: '#33ff66', border: '#1f9e40', code: '#7dff9e' },
  { id: 'crt-amber', accent: '#ffb000', user: '#ffd27a', assistant: '#ffb000', muted: '#a87400', reasoning: '#a87400', error: '#ff5f3a', warning: '#ffd27a', success: '#ffcc33', border: '#a87400', code: '#ffd27a' },
  { id: 'neon', accent: '#ff3cac', user: '#7df9ff', assistant: '#f5f5ff', muted: '#8a7fbf', reasoning: '#8a7fbf', error: '#ff4d6d', warning: '#ffd166', success: '#06d6a0', border: '#784ba0', code: '#7df9ff' },
];

export function findCliTheme(id: string | undefined): CliTheme {
  return CLI_THEMES.find((t) => t.id === id) ?? CLI_THEMES[0]!;
}
