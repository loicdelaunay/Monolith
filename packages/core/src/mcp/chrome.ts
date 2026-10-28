import { mkdirSync } from 'node:fs';
import type { Settings } from '@monolith/contracts';
import type { Logger } from '../log/logger.ts';
import type { ToolRegistry } from '../tools/registry.ts';
import type { ToolContext, ToolDefinition } from '../tools/types.ts';
import { allowedUrl } from '../tools/local-access.ts';
import { McpClient, type McpRawTool } from './client.ts';
import { mcpEffects, mcpResult, toInfo } from './service.ts';

/** Version épinglée de Chrome DevTools MCP (Google, Apache-2.0), lancée par npx. */
export const CHROME_DEVTOOLS_MCP = 'chrome-devtools-mcp@1.11.0';
const PREFIX = 'chrome__';

export interface ChromeMcpOptions {
  registry: ToolRegistry;
  logger: Logger;
  /** Profil Chrome dédié à Monolith (dans le dossier de données : portable, séparé du profil personnel). */
  profileDir: string;
  saveImage: (ctx: ToolContext, name: string, data: string) => number;
  /** Tests : commande remplaçant `npx chrome-devtools-mcp`. */
  command?: { command: string; args: string[] };
}

/**
 * Navigateur « Chrome du poste » (Réglages › Skills › Navigateur) : Chrome DevTools MCP, démarré à la
 * première génération qui en a besoin. Ses outils (`chrome__*`) remplacent ceux du navigateur intégré et
 * relèvent du skill Navigateur et de la famille d'autorisations `browser`.
 */
export class ChromeMcp {
  private client: McpClient | null = null;
  private key = '';
  private connecting: Promise<void> | null = null;

  constructor(private readonly o: ChromeMcpOptions) {}

  /** Outil exposé selon le navigateur choisi : intégré (`browser_*`) ou Chrome (`chrome__*`). */
  allows(tool: ToolDefinition, settings: Settings): boolean {
    const chrome = settings.browser.backend === 'chrome';
    if (tool.name.startsWith(PREFIX)) return chrome;
    if (tool.family === 'browser' && tool.name.startsWith('browser_')) return !chrome;
    return true;
  }

  /** Avant une génération : connecte Chrome DevTools MCP si choisi ; renvoie l'erreur éventuelle (non bloquante). */
  async ensure(settings: Settings): Promise<string | null> {
    if (settings.browser.backend !== 'chrome') {
      if (this.client) await this.stop();
      return null;
    }
    const key = settings.browser.chromePath;
    if (this.client && !this.client.closed && this.key === key) return null;
    if (this.connecting) {
      await this.connecting.catch(() => undefined);
      if (this.client && !this.client.closed && this.key === key) return null;
    }
    await this.stop();
    this.connecting = this.start(key);
    try {
      await this.connecting;
      return null;
    } catch (e) {
      return `Chrome DevTools MCP : ${(e as Error).message} (Node.js et Google Chrome sont requis).`;
    } finally {
      this.connecting = null;
    }
  }

  private async start(chromePath: string): Promise<void> {
    const cmd = this.o.command ?? {
      command: 'npx',
      args: ['-y', CHROME_DEVTOOLS_MCP, '--no-usage-statistics', `--user-data-dir=${this.o.profileDir}`, ...(chromePath ? [`--executable-path=${chromePath}`] : [])],
    };
    mkdirSync(this.o.profileDir, { recursive: true });
    const client = McpClient.stdio(cmd.command, cmd.args, {}, this.o.profileDir);
    try {
      await client.initialize();
      const tools = await client.listTools();
      this.client = client;
      this.key = chromePath;
      this.register(tools);
      this.o.logger.info('mcp', 'Chrome DevTools MCP connecté', { tools: tools.length });
    } catch (e) {
      await client.close();
      throw e;
    }
  }

  private register(raw: McpRawTool[]): void {
    this.o.registry.unregister(PREFIX);
    for (const t of raw) {
      const info = toInfo(t);
      this.o.registry.register({
        name: `${PREFIX}${t.name.replace(/[^a-zA-Z0-9_-]/g, '_')}`.slice(0, 64),
        family: 'browser',
        skill: 'browser',
        description: `[Chrome du poste] ${(t.description ?? info.title ?? t.name).slice(0, 1000)}`,
        parameters: t.inputSchema && t.inputSchema.type === 'object' ? t.inputSchema : { type: 'object', properties: {} },
        effects: mcpEffects(info),
        target: (a) => {
          const url = typeof a.url === 'string' ? a.url : '';
          return { label: `Chrome › ${info.title ?? t.name}${url ? ` · ${url}` : ''}`, resources: ['chrome', `chrome:${t.name}`, ...(url ? [url] : [])] };
        },
        execute: async (args, ctx) => {
          // Même règle que le navigateur intégré : une adresse locale demande l'accord de l'utilisateur.
          if (typeof args.url === 'string' && /^https?:/i.test(args.url)) await allowedUrl(args.url, ctx);
          const client = this.client;
          if (!client || client.closed) throw new Error('Chrome DevTools MCP déconnecté : relancez la génération.');
          const result = await client.callTool(t.name, args, ctx.signal, ctx.settings.agent.commandTimeoutSec * 1000);
          return mcpResult(result, ctx, 'Chrome', this.o.saveImage);
        },
      });
    }
  }

  private async stop(): Promise<void> {
    this.o.registry.unregister(PREFIX);
    const client = this.client;
    this.client = null;
    this.key = '';
    await client?.close();
  }

  async dispose(): Promise<void> {
    await this.stop();
  }
}
