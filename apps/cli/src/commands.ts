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
  { name: 'steer', args: '<texte>', help: 'cli.cmd.steer' },
  { name: 'queue', help: 'cli.cmd.queue' },
  { name: 'unqueue', args: '<n°>', help: 'cli.cmd.unqueue' },
  { name: 'next', help: 'cli.cmd.next' },
  { name: 'history', help: 'cli.cmd.history' },
  { name: 'resume', args: '<n°>', help: 'cli.cmd.resume' },
  { name: 'fork', args: '[n°]', help: 'cli.cmd.fork' },
  { name: 'export', args: '[fichier.md] [--reasoning]', help: 'cli.cmd.export' },
  { name: 'goal', args: '[texte | -]', help: 'cli.cmd.goal' },
  { name: 'compact', help: 'cli.cmd.compact' },
  { name: 'context', help: 'cli.cmd.context' },
  { name: 'templates', help: 'cli.cmd.templates' },
  { name: 'template', args: '<nom>', help: 'cli.cmd.template' },
  { name: 'attach', args: '<chemin>', help: 'cli.cmd.attach' },
  { name: 'detach', help: 'cli.cmd.detach' },
  { name: 'reasoning', args: '[niveau]', help: 'cli.cmd.reasoning' },
  { name: 'mode', args: '[chat | plan | propose | execute]', help: 'cli.cmd.mode' },
  { name: 'shortcut', args: '[n° | nom]', help: 'cli.cmd.shortcut' },
  { name: 'mcp', args: '[connect|disconnect|on|off <n°>]', help: 'cli.cmd.mcp' },
  { name: 'memory', args: '[texte]', help: 'cli.cmd.memory' },
  { name: 'rag', args: '[index | clear]', help: 'cli.cmd.rag' },
  { name: 'subagents', help: 'cli.cmd.subagents' },
  { name: 'sandbox', args: '[on | diff | apply <n°…> | discard]', help: 'cli.cmd.sandbox' },
  { name: 'resources', args: '[add <dossier> | file <fichier> | reset]', help: 'cli.cmd.resources' },
  { name: 'rules', help: 'cli.cmd.rules' },
  { name: 'allow', args: '<outil> [ressource]', help: 'cli.cmd.allow' },
  { name: 'deny', args: '<outil> [ressource]', help: 'cli.cmd.deny' },
  { name: 'unrule', args: '<n°>', help: 'cli.cmd.unrule' },
  { name: 'proposals', help: 'cli.cmd.proposals' },
  { name: 'apply', args: '<n°>', help: 'cli.cmd.apply' },
  { name: 'reject', args: '<n°>', help: 'cli.cmd.reject' },
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
