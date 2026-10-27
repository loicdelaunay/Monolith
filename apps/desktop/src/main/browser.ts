import { BrowserWindow, desktopCapturer, session, shell, WebContentsView, type Session } from 'electron';

/** État d'un onglet transmis à l'interface. */
export interface BrowserTabState {
  id: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  mobile: boolean;
  conversationId: number | null;
  error: string | null;
}

interface Tab {
  id: string;
  view: WebContentsView;
  mobile: boolean;
  conversationId: number | null;
  error: string | null;
}

const PARTITION = 'persist:mh-browser';
const ISOLATED_WORLD = 1999;
const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0 Mobile Safari/537.36';
const DEFAULT_BOUNDS = { x: 0, y: 0, width: 1280, height: 800 };

const allowedUrl = (url: string) => /^(https?:|file:|about:blank)/i.test(url);

/**
 * Navigateur intégré : onglets WebContentsView dans une partition isolée (aucun preload, sandbox,
 * aucune permission web, téléchargements refusés). L'interface positionne la vue au-dessus de
 * son panneau ; l'agent l'utilise par le pont hôte (lecture, DOM, clic, saisie, capture).
 */
export class BrowserManager {
  private readonly tabs = new Map<string, Tab>();
  private activeId: string | null = null;
  private visible = false;
  private bounds = DEFAULT_BOUNDS;
  private seq = 0;
  private sessionReady = false;

  constructor(
    private readonly window: () => BrowserWindow | null,
    private readonly emit: (tabs: BrowserTabState[], activeId: string | null, notice?: string) => void,
  ) {}

  private session(): Session {
    const s = session.fromPartition(PARTITION);
    if (!this.sessionReady) {
      this.sessionReady = true;
      s.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
      s.setPermissionCheckHandler(() => false);
      s.on('will-download', (event, item) => {
        event.preventDefault();
        this.notify(`Téléchargement bloqué : ${item.getFilename()} (le navigateur intégré n’enregistre aucun fichier).`);
      });
    }
    return s;
  }

  private notify(notice: string): void {
    this.emit(this.states(), this.activeId, notice);
  }

  get active(): string | null {
    return this.activeId;
  }

  states(): BrowserTabState[] {
    return [...this.tabs.values()].map((t) => {
      const wc = t.view.webContents;
      return {
        id: t.id,
        url: wc.getURL(),
        title: wc.getTitle() || wc.getURL() || 'Nouvel onglet',
        loading: wc.isLoading(),
        canGoBack: wc.navigationHistory.canGoBack(),
        canGoForward: wc.navigationHistory.canGoForward(),
        mobile: t.mobile,
        conversationId: t.conversationId,
        error: t.error,
      };
    });
  }

  private changed = () => this.emit(this.states(), this.activeId);

  create(url: string | null, conversationId: number | null = null): Tab {
    const win = this.window();
    if (!win) throw new Error('Fenêtre principale indisponible.');
    const view = new WebContentsView({
      webPreferences: { session: this.session(), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, javascript: true, spellcheck: false },
    });
    const id = `t${++this.seq}`;
    const tab: Tab = { id, view, mobile: false, conversationId, error: null };
    this.tabs.set(id, tab);
    const wc = view.webContents;
    wc.setWindowOpenHandler(({ url: target }) => {
      if (/^https?:/i.test(target)) this.select(this.create(target, conversationId).id);
      return { action: 'deny' };
    });
    wc.on('will-navigate', (event, target) => {
      if (!allowedUrl(target)) event.preventDefault();
    });
    for (const ev of ['did-start-loading', 'did-stop-loading', 'page-title-updated', 'did-navigate', 'did-navigate-in-page'] as const) wc.on(ev as 'did-start-loading', this.changed);
    wc.on('did-fail-load', (_e, code, description, failedUrl, isMainFrame) => {
      if (isMainFrame && code !== -3) {
        tab.error = `${description} (${code}) — ${failedUrl}`;
        this.changed();
      }
    });
    wc.on('did-start-navigation', () => {
      tab.error = null;
    });
    view.setVisible(false);
    view.setBounds(this.bounds);
    win.contentView.addChildView(view);
    if (url) void this.load(tab, url);
    this.changed();
    return tab;
  }

  private async load(tab: Tab, url: string): Promise<void> {
    let target = url.trim();
    if (!/^[a-z]+:/i.test(target)) target = /^[\w-]+(\.[\w-]+)+(:\d+)?(\/|$)/.test(target) || /^localhost(:\d+)?/.test(target) ? `https://${target}` : `https://duckduckgo.com/?q=${encodeURIComponent(target)}`;
    if (/^localhost/.test(url.trim())) target = `http://${url.trim()}`;
    if (!allowedUrl(target)) throw new Error('Seules les adresses http(s) et les fichiers locaux sont autorisés.');
    tab.error = null;
    try {
      await tab.view.webContents.loadURL(target);
    } catch {
      /* l'erreur est rapportée par did-fail-load */
    }
  }

  private tab(id: string | null | undefined): Tab {
    const tab = this.tabs.get(id ?? this.activeId ?? '');
    if (!tab) throw new Error('Aucun onglet ouvert dans le navigateur intégré.');
    return tab;
  }

  select(id: string): void {
    if (!this.tabs.has(id)) return;
    this.activeId = id;
    this.layout();
    this.changed();
  }

  close(id: string): void {
    const tab = this.tabs.get(id);
    if (!tab) return;
    this.window()?.contentView.removeChildView(tab.view);
    tab.view.webContents.close();
    this.tabs.delete(id);
    if (this.activeId === id) this.activeId = [...this.tabs.keys()].at(-1) ?? null;
    this.layout();
    this.changed();
  }

  /** Position du panneau dans la fenêtre (null = panneau masqué ou recouvert par une boîte de dialogue). */
  setBounds(bounds: { x: number; y: number; width: number; height: number } | null): void {
    this.visible = bounds !== null && bounds.width > 20 && bounds.height > 20;
    if (bounds && this.visible) this.bounds = { x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.round(bounds.width), height: Math.round(bounds.height) };
    this.layout();
  }

  private layout(): void {
    for (const t of this.tabs.values()) {
      const show = this.visible && t.id === this.activeId;
      // Taille conservée même masquée : les captures de l'agent restent possibles.
      t.view.setBounds(this.bounds);
      t.view.setVisible(show);
    }
  }

  async command(cmd: string, args: Record<string, unknown>): Promise<void> {
    const id = typeof args.id === 'string' ? args.id : null;
    switch (cmd) {
      case 'new':
        this.select(this.create(typeof args.url === 'string' && args.url ? args.url : 'about:blank').id);
        return;
      case 'navigate':
        if (!this.activeId && !id) this.select(this.create(null).id);
        await this.load(this.tab(id), String(args.url ?? ''));
        return;
      case 'back':
        this.tab(id).view.webContents.navigationHistory.goBack();
        return;
      case 'forward':
        this.tab(id).view.webContents.navigationHistory.goForward();
        return;
      case 'reload':
        this.tab(id).view.webContents.reload();
        return;
      case 'stop':
        this.tab(id).view.webContents.stop();
        return;
      case 'select':
        if (id) this.select(id);
        return;
      case 'close':
        if (id) this.close(id);
        return;
      case 'mobile':
        this.setMobile(this.tab(id), args.value === true);
        return;
      case 'devtools':
        this.tab(id).view.webContents.openDevTools({ mode: 'detach' });
        return;
      case 'external': {
        const url = this.tab(id).view.webContents.getURL();
        if (/^https?:/i.test(url)) await shell.openExternal(url);
        return;
      }
      case 'clearData':
        await this.session().clearStorageData();
        await this.session().clearCache();
        this.notify('Données de navigation effacées (cookies, stockage, cache).');
        return;
    }
  }

  private setMobile(tab: Tab, mobile: boolean): void {
    const wc = tab.view.webContents;
    tab.mobile = mobile;
    if (mobile) {
      wc.enableDeviceEmulation({ screenPosition: 'mobile', screenSize: { width: 390, height: 844 }, viewPosition: { x: 0, y: 0 }, deviceScaleFactor: 0, viewSize: { width: 390, height: 844 }, scale: 1 });
      wc.setUserAgent(MOBILE_UA);
    } else {
      wc.disableDeviceEmulation();
      wc.setUserAgent(session.fromPartition(PARTITION).getUserAgent());
    }
    wc.reload();
    this.changed();
  }

  /** Onglet de l'agent : celui demandé, sinon celui de la conversation, sinon un nouveau. */
  private agentTab(args: Record<string, unknown>, create = false): Tab {
    if (typeof args.tabId === 'string' && this.tabs.has(args.tabId)) return this.tabs.get(args.tabId)!;
    const conv = typeof args.conversationId === 'number' ? args.conversationId : null;
    const own = [...this.tabs.values()].reverse().find((t) => t.conversationId === conv);
    if (own) return own;
    if (!create && this.activeId) return this.tab(this.activeId);
    if (!create) throw new Error('Aucun onglet ouvert : utilisez browser_open.');
    const tab = this.create(null, conv);
    if (!this.activeId) this.activeId = tab.id;
    return tab;
  }

  private page(tab: Tab) {
    const wc = tab.view.webContents;
    return { tabId: tab.id, url: wc.getURL(), title: wc.getTitle() };
  }

  private async waitLoad(tab: Tab, timeoutMs = 20_000): Promise<void> {
    const wc = tab.view.webContents;
    if (!wc.isLoading()) return;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        wc.off('did-stop-loading', done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      wc.on('did-stop-loading', done);
    });
  }

  private run<T>(tab: Tab, code: string): Promise<T> {
    // Monde isolé : le script de la page ne peut ni observer ni falsifier nos fonctions.
    return tab.view.webContents.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD, [{ code }]) as Promise<T>;
  }

  /** Requêtes de l'agent (via le moteur). */
  async hostRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'browser.open': {
        const tab = params.newTab === true ? this.create(null, typeof params.conversationId === 'number' ? params.conversationId : null) : this.agentTab(params, true);
        if (!this.activeId || params.newTab === true) this.activeId = tab.id;
        await this.load(tab, String(params.url));
        await this.waitLoad(tab);
        this.changed();
        if (tab.error) throw new Error(`Chargement impossible : ${tab.error}`);
        return this.page(tab);
      }
      case 'browser.read': {
        const tab = this.agentTab(params);
        await this.waitLoad(tab);
        const text = await this.run<string>(tab, `(document.body ? document.body.innerText : '').slice(0, 200000)`);
        return { ...this.page(tab), text };
      }
      case 'browser.dom': {
        const tab = this.agentTab(params);
        await this.waitLoad(tab);
        const code = `(() => {
          const sel = ${JSON.stringify(String(params.selector))};
          let nodes;
          try { nodes = [...document.querySelectorAll(sel)]; } catch (e) { return { error: 'Sélecteur invalide' }; }
          const keep = ['id','class','name','type','href','src','value','placeholder','aria-label','role','title','alt'];
          return { total: nodes.length, matches: nodes.slice(0, ${Number(params.max) || 20}).map((n) => ({
            tag: n.tagName.toLowerCase(),
            attributes: Object.fromEntries(keep.filter((k) => n.getAttribute && n.getAttribute(k) != null).map((k) => [k, String(n.getAttribute(k)).slice(0, 200)])),
            text: (n.innerText || n.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 300),
          })) };
        })()`;
        const r = await this.run<{ error?: string; total: number; matches: unknown[] }>(tab, code);
        if (r.error) throw new Error(r.error);
        return r;
      }
      case 'browser.click': {
        const tab = this.agentTab(params);
        const code = `(() => {
          let el; try { el = document.querySelector(${JSON.stringify(String(params.selector))}); } catch { return { ok: false, message: 'Sélecteur invalide' }; }
          if (!el) return { ok: false, message: 'Aucun élément ne correspond au sélecteur.' };
          el.scrollIntoView({ block: 'center' });
          el.click();
          return { ok: true, message: 'Clic effectué sur <' + el.tagName.toLowerCase() + '> ' + (el.innerText || '').trim().slice(0, 80) };
        })()`;
        const r = await this.run<{ ok: boolean; message: string }>(tab, code);
        await new Promise((res) => setTimeout(res, 400));
        await this.waitLoad(tab, 10_000);
        return r;
      }
      case 'browser.type': {
        const tab = this.agentTab(params);
        const code = `(() => {
          let el; try { el = document.querySelector(${JSON.stringify(String(params.selector))}); } catch { return { ok: false, message: 'Sélecteur invalide' }; }
          if (!el) return { ok: false, message: 'Aucun champ ne correspond au sélecteur.' };
          if (el.type === 'password') return { ok: false, message: 'Saisie refusée dans un champ de mot de passe.' };
          el.focus();
          const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value');
          if (el.isContentEditable) el.textContent = ${JSON.stringify(String(params.text))};
          else if (setter && setter.set) setter.set.call(el, ${JSON.stringify(String(params.text))});
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          if (${params.submit === true}) { if (el.form) el.form.requestSubmit(); else el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); }
          return { ok: true, message: 'Texte saisi dans <' + el.tagName.toLowerCase() + '>' + (${params.submit === true} ? ' et formulaire envoyé' : '') };
        })()`;
        const r = await this.run<{ ok: boolean; message: string }>(tab, code);
        await this.waitLoad(tab, 10_000);
        return r;
      }
      case 'browser.screenshot': {
        const tab = this.agentTab(params);
        await this.waitLoad(tab);
        const image = await tab.view.webContents.capturePage(undefined, { stayHidden: true });
        if (image.isEmpty()) throw new Error('Capture vide (page non rendue).');
        return { ...this.page(tab), dataBase64: image.toPNG().toString('base64') };
      }
      case 'desktop.screenshot': {
        const title = String(params.title ?? '').toLowerCase();
        const sources = await desktopCapturer.getSources({ types: title ? ['window'] : ['screen'], thumbnailSize: { width: 1920, height: 1200 } });
        const source = title ? sources.find((s) => s.name.toLowerCase().includes(title)) : sources[0];
        if (!source || source.thumbnail.isEmpty()) throw new Error(title ? `Aucune fenêtre visible ne correspond à « ${params.title} ».` : 'Capture d’écran indisponible.');
        return { name: source.name, dataBase64: source.thumbnail.toPNG().toString('base64') };
      }
      default:
        throw new Error(`Méthode hôte inconnue : ${method}`);
    }
  }

  /** Capture de la vue affichée (tests visuels : la capture de la fenêtre n'inclut pas les vues natives). */
  async captureVisible(): Promise<Electron.NativeImage | null> {
    const tab = this.visible && this.activeId ? this.tabs.get(this.activeId) : null;
    return tab ? tab.view.webContents.capturePage() : null;
  }

  dispose(): void {
    for (const id of [...this.tabs.keys()]) this.close(id);
  }
}
