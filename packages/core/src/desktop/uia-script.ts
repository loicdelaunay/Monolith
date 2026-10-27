/**
 * Assistant PowerShell (Windows PowerShell 5.1, thread MTA) : une requête JSON par ligne sur
 * l'entrée standard, une réponse JSON par ligne. UI Automation passe par l'API COM native
 * (UIAutomationCore.dll, proxys MSAA/Win32 compris) ; l'interop est générée une fois à partir de la
 * bibliothèque de types du système, sans téléchargement. UI Automation n'injecte aucun événement
 * physique ; le mode Legacy (curseur, SendKeys) est séparé et appelé explicitement.
 */

/** Génération de l'assembly d'interop depuis la bibliothèque de types de UIAutomationCore.dll. */
const TLB_SOURCE = String.raw`
using System;
using System.IO;
using System.Reflection;
using System.Reflection.Emit;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;

public static class MhTlb {
  [DllImport("oleaut32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void LoadTypeLibEx(string file, int regKind, out ITypeLib lib);

  class Sink : ITypeLibImporterNotifySink {
    public void ReportEvent(ImporterEventKind kind, int code, string message) { }
    public Assembly ResolveRef(object typeLib) {
      string name = Marshal.GetTypeLibName((ITypeLib)typeLib);
      if (name == "Accessibility") return Assembly.Load("Accessibility, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a");
      if (name == "stdole") return Assembly.Load("stdole, Version=7.0.3300.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a");
      return null;
    }
  }

  public static void Make(string path) {
    ITypeLib lib;
    LoadTypeLibEx("UIAutomationCore.dll", 2, out lib);
    TypeLibConverter conv = new TypeLibConverter();
    AssemblyBuilder ab = conv.ConvertTypeLibToAssembly(lib, path, TypeLibImporterFlags.None, new Sink(), null, null, "Interop.UIAutomationClient", null);
    ab.Save(Path.GetFileName(path));
  }
}
`;

const UIA_SOURCE = String.raw`
using System;
using System.Collections;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;
using UIA = Interop.UIAutomationClient;

public class MhUnsupported : Exception {
  public MhUnsupported(string capability) : base("UNSUPPORTED:" + capability) { }
}

public static class MhUia {
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);

  class Entry { public UIA.IUIAutomationElement El; public string Win; public DateTime At; }

  static UIA.IUIAutomation A;
  static readonly Dictionary<string, Entry> Cache = new Dictionary<string, Entry>();
  static readonly HashSet<int> Blocked = new HashSet<int>();
  static readonly string[] TypeNames = { "Button", "Calendar", "CheckBox", "ComboBox", "Edit", "Hyperlink", "Image", "ListItem", "List", "Menu", "MenuBar", "MenuItem", "ProgressBar", "RadioButton", "ScrollBar", "Slider", "Spinner", "StatusBar", "Tab", "TabItem", "Text", "ToolBar", "ToolTip", "Tree", "TreeItem", "Custom", "Group", "Thumb", "DataGrid", "DataItem", "Document", "SplitButton", "Window", "Pane", "Header", "HeaderItem", "Table", "TitleBar", "Separator", "SemanticZoom", "AppBar" };
  static readonly int[] PatternIds = { 10000, 10015, 10010, 10005, 10004, 10017, 10002 };
  static readonly string[] PatternNames = { "Invoke", "Toggle", "SelectionItem", "ExpandCollapse", "Scroll", "ScrollItem", "Value" };
  const int LegacyPattern = 10018;

  public static void Init(string blocked) {
    // Coordonnées physiques : celles de UI Automation et du curseur coïncident.
    SetProcessDPIAware();
    if (!string.IsNullOrEmpty(blocked)) foreach (string s in blocked.Split(',')) { int p; if (int.TryParse(s, out p)) Blocked.Add(p); }
    try {
      UIA.IUIAutomation2 a2 = new UIA.CUIAutomation8();
      // Délais natifs de connexion et de transaction : un fournisseur bloqué ne fige pas l'assistant.
      a2.ConnectionTimeout = 3000;
      a2.TransactionTimeout = 8000;
      A = a2;
    } catch (Exception) {
      A = new UIA.CUIAutomation();
    }
  }

  static string Rt(UIA.IUIAutomationElement e) {
    Array a = (Array)e.GetRuntimeId();
    List<string> parts = new List<string>();
    foreach (object o in a) parts.Add(o.ToString());
    return string.Join(".", parts.ToArray());
  }

  static int[] Rect(UIA.IUIAutomationElement e) {
    UIA.tagRECT r = e.CurrentBoundingRectangle;
    if (r.right <= r.left || r.bottom <= r.top) return null;
    return new int[] { r.left, r.top, r.right - r.left, r.bottom - r.top };
  }

  static UIA.IUIAutomationElementArray TopLevel() {
    return A.GetRootElement().FindAll(UIA.TreeScope.TreeScope_Children, A.CreateTrueCondition());
  }

  public static ArrayList Windows() {
    ArrayList list = new ArrayList();
    UIA.IUIAutomationElementArray arr = TopLevel();
    for (int i = 0; i < arr.Length; i++) {
      UIA.IUIAutomationElement w = arr.GetElement(i);
      try {
        string name = w.CurrentName;
        string cls = w.CurrentClassName;
        int pid = w.CurrentProcessId;
        if (string.IsNullOrEmpty(name) && string.IsNullOrEmpty(cls)) continue;
        if (Blocked.Contains(pid)) continue;
        string proc = "";
        try { proc = System.Diagnostics.Process.GetProcessById(pid).ProcessName; } catch (Exception) { }
        Hashtable h = new Hashtable();
        h["window_id"] = Rt(w);
        h["title"] = name ?? "";
        h["process"] = proc;
        h["pid"] = pid;
        h["class"] = cls ?? "";
        h["bounds"] = Rect(w);
        list.Add(h);
      } catch (COMException) { }
    }
    return list;
  }

  static UIA.IUIAutomationElement FindWindow(string id) {
    UIA.IUIAutomationElementArray arr = TopLevel();
    for (int i = 0; i < arr.Length; i++) {
      UIA.IUIAutomationElement w = arr.GetElement(i);
      string rt;
      try { rt = Rt(w); } catch (COMException) { continue; }
      if (rt != id) continue;
      if (Blocked.Contains(w.CurrentProcessId)) throw new Exception("Fenêtre de Monolith : son contrôle par l'IA est interdit.");
      return w;
    }
    throw new Exception("Fenêtre introuvable (fermée ?) : relancez desktop_inspect_ui sans window_id.");
  }

  static UIA.IUIAutomationElement Get(string win, string id) {
    Entry e;
    if (!Cache.TryGetValue(id, out e)) throw new Exception("Élément inconnu ou expiré : inspectez de nouveau la fenêtre.");
    if ((DateTime.UtcNow - e.At).TotalMinutes > 10) { Cache.Remove(id); throw new Exception("Élément expiré (10 min) : inspectez de nouveau la fenêtre."); }
    if (e.Win != win) throw new Exception("Cet élément n'appartient pas à la fenêtre demandée.");
    // Le contrôle doit toujours appartenir à la fenêtre.
    UIA.IUIAutomationTreeWalker raw = A.RawViewWalker;
    UIA.IUIAutomationElement p = e.El;
    for (int i = 0; i < 64 && p != null; i++) {
      if (Rt(p) == win) return e.El;
      p = raw.GetParentElement(p);
    }
    throw new Exception("Le contrôle n'appartient plus à la fenêtre demandée.");
  }

  static Hashtable Describe(UIA.IUIAutomationElement el, string win, string parent, int depth) {
    string id = Guid.NewGuid().ToString("N").Substring(0, 10);
    Entry en = new Entry();
    en.El = el; en.Win = win; en.At = DateTime.UtcNow;
    Cache[id] = en;
    Hashtable h = new Hashtable();
    h["element_id"] = id;
    h["parent"] = parent;
    h["depth"] = depth;
    int ct = el.CurrentControlType;
    h["type"] = ct >= 50000 && ct - 50000 < TypeNames.Length ? TypeNames[ct - 50000] : ct.ToString();
    string name = el.CurrentName ?? "";
    h["name"] = name.Length > 200 ? name.Substring(0, 200) : name;
    h["automation_id"] = el.CurrentAutomationId ?? "";
    h["class"] = el.CurrentClassName ?? "";
    h["enabled"] = el.CurrentIsEnabled != 0;
    h["password"] = el.CurrentIsPassword != 0;
    h["focusable"] = el.CurrentIsKeyboardFocusable != 0;
    ArrayList pats = new ArrayList();
    for (int i = 0; i < PatternIds.Length; i++) {
      try { if (el.GetCurrentPattern(PatternIds[i]) != null) pats.Add(PatternNames[i]); } catch (COMException) { }
    }
    if (!pats.Contains("Invoke")) {
      try {
        UIA.IUIAutomationLegacyIAccessiblePattern la = el.GetCurrentPattern(LegacyPattern) as UIA.IUIAutomationLegacyIAccessiblePattern;
        if (la != null && !string.IsNullOrEmpty(la.CurrentDefaultAction)) pats.Add("DefaultAction");
      } catch (COMException) { }
    }
    h["patterns"] = pats;
    h["bounds"] = Rect(el);
    return h;
  }

  public static Hashtable Inspect(string win, string parent, int depth, int max) {
    UIA.IUIAutomationElement w = FindWindow(win);
    if (string.IsNullOrEmpty(parent)) {
      // Nouvelle inspection complète : les identifiants précédents de cette fenêtre expirent.
      List<string> old = new List<string>();
      foreach (KeyValuePair<string, Entry> kv in Cache) if (kv.Value.Win == win) old.Add(kv.Key);
      foreach (string k in old) Cache.Remove(k);
    }
    UIA.IUIAutomationElement start = string.IsNullOrEmpty(parent) ? w : Get(win, parent);
    UIA.IUIAutomationTreeWalker walker = A.ControlViewWalker;
    ArrayList nodes = new ArrayList();
    bool truncated = false;
    Queue<object[]> q = new Queue<object[]>();
    q.Enqueue(new object[] { start, 0, null });
    while (q.Count > 0) {
      if (nodes.Count >= max) { truncated = true; break; }
      object[] it = q.Dequeue();
      UIA.IUIAutomationElement el = (UIA.IUIAutomationElement)it[0];
      int d = (int)it[1];
      Hashtable h;
      try { h = Describe(el, win, (string)it[2], d); } catch (COMException) { continue; }
      nodes.Add(h);
      UIA.IUIAutomationElement c = null;
      try { c = walker.GetFirstChildElement(el); } catch (COMException) { }
      if (d >= depth) { if (c != null) truncated = true; continue; }
      while (c != null) {
        q.Enqueue(new object[] { c, d + 1, h["element_id"] });
        try { c = walker.GetNextSiblingElement(c); } catch (COMException) { c = null; }
      }
    }
    Hashtable r = new Hashtable();
    r["nodes"] = nodes;
    r["truncated"] = truncated;
    return r;
  }

  static T Pat<T>(UIA.IUIAutomationElement el, int id, string name) where T : class {
    T p = el.GetCurrentPattern(id) as T;
    if (p == null) throw new MhUnsupported(name);
    return p;
  }

  public static Hashtable Act(string win, string element, string action, string text, string direction) {
    UIA.IUIAutomationElement el = Get(win, element);
    if (el.CurrentIsEnabled == 0) throw new Exception("Contrôle désactivé.");
    switch (action) {
      case "invoke": {
        UIA.IUIAutomationInvokePattern inv = el.GetCurrentPattern(10000) as UIA.IUIAutomationInvokePattern;
        if (inv != null) { inv.Invoke(); break; }
        // Contrôle Win32 sans Invoke : action par défaut de l'accessibilité (toujours sans saisie physique).
        UIA.IUIAutomationLegacyIAccessiblePattern la = el.GetCurrentPattern(LegacyPattern) as UIA.IUIAutomationLegacyIAccessiblePattern;
        if (la == null || string.IsNullOrEmpty(la.CurrentDefaultAction)) throw new MhUnsupported("Invoke");
        la.DoDefaultAction();
        break;
      }
      case "toggle": Pat<UIA.IUIAutomationTogglePattern>(el, 10015, "Toggle").Toggle(); break;
      case "select": Pat<UIA.IUIAutomationSelectionItemPattern>(el, 10010, "SelectionItem").Select(); break;
      case "expand": Pat<UIA.IUIAutomationExpandCollapsePattern>(el, 10005, "ExpandCollapse").Expand(); break;
      case "collapse": Pat<UIA.IUIAutomationExpandCollapsePattern>(el, 10005, "ExpandCollapse").Collapse(); break;
      case "scroll_into_view": Pat<UIA.IUIAutomationScrollItemPattern>(el, 10017, "ScrollItem").ScrollIntoView(); break;
      case "scroll": {
        UIA.IUIAutomationScrollPattern sp = Pat<UIA.IUIAutomationScrollPattern>(el, 10004, "Scroll");
        UIA.ScrollAmount h = UIA.ScrollAmount.ScrollAmount_NoAmount, v = UIA.ScrollAmount.ScrollAmount_NoAmount;
        if (direction == "up") v = UIA.ScrollAmount.ScrollAmount_LargeDecrement;
        else if (direction == "left") h = UIA.ScrollAmount.ScrollAmount_LargeDecrement;
        else if (direction == "right") h = UIA.ScrollAmount.ScrollAmount_LargeIncrement;
        else v = UIA.ScrollAmount.ScrollAmount_LargeIncrement;
        sp.Scroll(h, v);
        break;
      }
      case "set_value": Pat<UIA.IUIAutomationValuePattern>(el, 10002, "Value").SetValue(text ?? ""); break;
      case "type": {
        if (el.CurrentIsPassword != 0) throw new Exception("Champ de mot de passe : seul set_value explicite est autorisé.");
        UIA.IUIAutomationValuePattern vp = Pat<UIA.IUIAutomationValuePattern>(el, 10002, "Value");
        vp.SetValue((vp.CurrentValue ?? "") + (text ?? ""));
        break;
      }
      default: throw new MhUnsupported(action);
    }
    Hashtable r = new Hashtable();
    r["done"] = true;
    r["target"] = el.CurrentName ?? "";
    return r;
  }

  static void Click(int x, int y, int count, bool right) {
    SetCursorPos(x, y);
    uint down = right ? 0x0008u : 0x0002u, up = right ? 0x0010u : 0x0004u;
    for (int i = 0; i < count; i++) { mouse_event(down, 0, 0, 0, UIntPtr.Zero); mouse_event(up, 0, 0, 0, UIntPtr.Zero); Thread.Sleep(60); }
  }

  static string Escape(string t) {
    System.Text.StringBuilder sb = new System.Text.StringBuilder();
    foreach (char c in (t ?? "").Replace("\r\n", "\n")) {
      if ("+^%~(){}[]".IndexOf(c) >= 0) sb.Append('{').Append(c).Append('}');
      else if (c == '\n') sb.Append("{ENTER}");
      else sb.Append(c);
    }
    return sb.ToString();
  }

  public static Hashtable Legacy(string win, string action, string element, double xd, double yd, bool hasXY, string text, string keys, string direction) {
    UIA.IUIAutomationElement w = FindWindow(win);
    int[] wr = Rect(w);
    if (wr == null) throw new Exception("Fenêtre sans position à l'écran (réduite ?).");
    // Point visé : centre de l'élément inspecté, sinon coordonnées explicites, toujours dans la fenêtre.
    bool has = false;
    int x = 0, y = 0;
    if (!string.IsNullOrEmpty(element)) {
      int[] b = Rect(Get(win, element));
      if (b == null) throw new Exception("Élément sans position à l'écran.");
      x = b[0] + b[2] / 2; y = b[1] + b[3] / 2; has = true;
    } else if (hasXY) {
      x = (int)xd; y = (int)yd; has = true;
    }
    if (has && (x < wr[0] || x > wr[0] + wr[2] || y < wr[1] || y > wr[1] + wr[3])) throw new Exception("Coordonnées hors de la fenêtre ciblée.");
    SetForegroundWindow(w.CurrentNativeWindowHandle);
    Thread.Sleep(120);
    Hashtable r = new Hashtable();
    r["done"] = true;
    if (action == "click" || action == "double_click" || action == "right_click") {
      if (!has) throw new Exception("Coordonnées ou élément requis.");
      Click(x, y, action == "double_click" ? 2 : 1, action == "right_click");
      r["x"] = x; r["y"] = y;
      return r;
    }
    if (action == "scroll") {
      if (!has) { x = wr[0] + wr[2] / 2; y = wr[1] + wr[3] / 2; }
      SetCursorPos(x, y);
      int delta = direction == "up" || direction == "right" ? 360 : -360;
      mouse_event(direction == "left" || direction == "right" ? 0x01000u : 0x0800u, 0, 0, unchecked((uint)delta), UIntPtr.Zero);
      r["x"] = x; r["y"] = y;
      return r;
    }
    // Clavier : un élément ciblé reçoit d'abord le focus par un clic.
    if (has) { Click(x, y, 1, false); Thread.Sleep(80); }
    if (action == "keys") SendKeys.SendWait(keys ?? "");
    else if (action == "type") SendKeys.SendWait(Escape(text));
    else if (action == "set_value") { SendKeys.SendWait("^a"); SendKeys.SendWait(string.IsNullOrEmpty(text) ? "{DEL}" : Escape(text)); }
    else throw new Exception("Action Legacy inconnue : " + action);
    return r;
  }
}
`;

export const UIA_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$interop = Join-Path $PSScriptRoot 'Interop.UIAutomationClient.dll'
if (-not (Test-Path $interop)) {
  Add-Type -TypeDefinition @'
${TLB_SOURCE}
'@
  [MhTlb]::Make($interop)
}
[void][Reflection.Assembly]::LoadFrom($interop)
Add-Type -ReferencedAssemblies @($interop, 'System.Windows.Forms') -TypeDefinition @'
${UIA_SOURCE}
'@
[MhUia]::Init([string]$env:MH_BLOCKED_PIDS)
[Console]::Out.WriteLine('{"id":0,"ok":true,"result":"ready"}')
[Console]::Out.Flush()

function Handle($req) {
  switch ($req.cmd) {
    'windows' { return ,([MhUia]::Windows()) }
    'inspect' { return [MhUia]::Inspect([string]$req.window, [string]$req.parent, [int]$req.depth, [int]$req.max) }
    'act' { return [MhUia]::Act([string]$req.window, [string]$req.element, [string]$req.action, [string]$req.text, [string]$req.direction) }
    'legacy' { return [MhUia]::Legacy([string]$req.window, [string]$req.action, [string]$req.element, [double]$req.x, [double]$req.y, ($req.x -ne $null -and $req.y -ne $null), [string]$req.text, [string]$req.keys, [string]$req.direction) }
    'ping' { return @{ pong = $true } }
    default { throw "Commande inconnue : $($req.cmd)" }
  }
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  if (-not $line.Trim()) { continue }
  $req = $null
  try {
    $req = $line | ConvertFrom-Json
    $result = Handle $req
    $res = @{ id = $req.id; ok = $true; result = $result }
  } catch {
    $e = $_.Exception
    while ($e.InnerException) { $e = $e.InnerException }
    $res = @{ id = if ($req) { $req.id } else { 0 }; ok = $false; error = $e.Message }
  }
  [Console]::Out.WriteLine((ConvertTo-Json -InputObject $res -Depth 10 -Compress))
  [Console]::Out.Flush()
}
`;
