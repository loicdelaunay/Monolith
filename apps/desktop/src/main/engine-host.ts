import { MessageChannelMain, utilityProcess, type UtilityProcess, type WebContents } from 'electron';
import { EventEmitter } from 'node:events';

interface ReadyMessage {
  type: 'ready';
  dataDir: string;
  titleBar: 'custom' | 'system';
  zoom: number;
  readOnly: boolean;
}

type EngineMessage = ReadyMessage | { type: 'fatal'; message: string } | { type: 'settings'; titleBar: 'custom' | 'system'; zoom: number };

/**
 * Cycle de vie du processus moteur. En cas d'arrêt inattendu, il est relancé (au plus
 * 3 fois par minute) et les fenêtres reçoivent un nouveau port.
 */
export class EngineHost extends EventEmitter {
  private child: UtilityProcess | null = null;
  private stopping = false;
  private restarts: number[] = [];
  private readonly clients = new Set<WebContents>();
  dataDir: string | null = null;
  titleBar: 'custom' | 'system' = 'custom';

  constructor(private readonly options: { entry: string; env: Record<string, string> }) {
    super();
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = utilityProcess.fork(this.options.entry, [], {
        serviceName: 'Monolith Harness Engine',
        env: { ...process.env, ...this.options.env },
        stdio: 'inherit',
      });
      this.child = child;
      let ready = false;
      child.on('message', (msg: EngineMessage) => {
        if (msg.type === 'ready') {
          ready = true;
          this.dataDir = msg.dataDir;
          this.titleBar = msg.titleBar;
          resolve();
        } else if (msg.type === 'fatal') {
          reject(new Error(msg.message));
        } else if (msg.type === 'settings') {
          this.titleBar = msg.titleBar;
        }
      });
      child.on('exit', (code) => {
        this.child = null;
        if (!ready) {
          reject(new Error(`Le moteur s’est arrêté au démarrage (code ${code}).`));
          return;
        }
        if (this.stopping) return;
        const now = Date.now();
        this.restarts = this.restarts.filter((t) => now - t < 60_000);
        if (this.restarts.length >= 3) {
          this.emit('failed');
          return;
        }
        this.restarts.push(now);
        void this.start().then(() => {
          for (const wc of this.clients) if (!wc.isDestroyed()) this.connect(wc);
          this.emit('restarted');
        });
      });
    });
  }

  /** Crée un canal direct fenêtre ↔ moteur ; le processus principal ne relaie aucun message. */
  connect(wc: WebContents): void {
    if (!this.child) return;
    const { port1, port2 } = new MessageChannelMain();
    this.child.postMessage({ type: 'connect' }, [port1]);
    wc.postMessage('engine:port', null, [port2]);
    if (!this.clients.has(wc)) {
      this.clients.add(wc);
      wc.once('destroyed', () => this.clients.delete(wc));
    }
  }

  stop(): void {
    this.stopping = true;
    this.child?.postMessage({ type: 'shutdown' });
  }
}
