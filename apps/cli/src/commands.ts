/** Commandes du CLI : nom, arguments et clé d'aide (les actions sont dans app.tsx). */
export interface CommandSpec {
  name: string;
  args?: string;
  help: string;
}

export const COMMANDS: CommandSpec[] = [
  { name: 'help', help: 'cli.cmd.help' },
  { name: 'new', args: '[titre]', help: 'cli.cmd.new' },
  { name: 'list', args: '[all]', help: 'cli.cmd.list' },
  { name: 'open', args: '<n° | texte>', help: 'cli.cmd.open' },
  { name: 'rename', args: '<titre>', help: 'cli.cmd.rename' },
  { name: 'delete', help: 'cli.cmd.delete' },
  { name: 'archive', help: 'cli.cmd.archive' },
  { name: 'pin', help: 'cli.cmd.pin' },
  { name: 'fav', help: 'cli.cmd.fav' },
  { name: 'search', args: '<texte>', help: 'cli.cmd.search' },
  { name: 'projects', help: 'cli.cmd.projects' },
  { name: 'project', args: '<nom | n° | new nom | perso>', help: 'cli.cmd.project' },
  { name: 'move', args: '<projet | perso>', help: 'cli.cmd.move' },
  { name: 'providers', help: 'cli.cmd.providers' },
  { name: 'model', args: '[connexion/]modèle', help: 'cli.cmd.model' },
  { name: 'cancel', help: 'cli.cmd.cancel' },
  { name: 'theme', args: '<nom>', help: 'cli.cmd.theme' },
  { name: 'info', help: 'cli.cmd.info' },
  { name: 'changelog', help: 'cli.cmd.changelog' },
  { name: 'quit', help: 'cli.cmd.quit' },
];

/** Suggestions pour une saisie commençant par « / » (sans argument encore tapé). */
export function completions(input: string): CommandSpec[] {
  if (!input.startsWith('/') || input.includes(' ') || input.includes('\n')) return [];
  const prefix = input.slice(1).toLowerCase();
  return COMMANDS.filter((c) => c.name.startsWith(prefix));
}

export function parseCommand(input: string): { name: string; arg: string } | null {
  const m = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(input.trim());
  return m ? { name: m[1]!.toLowerCase(), arg: (m[2] ?? '').trim() } : null;
}
