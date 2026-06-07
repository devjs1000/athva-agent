import { Command, Child } from "@tauri-apps/plugin-shell";
import { resolveResource } from "@tauri-apps/api/path";

export interface TreeNode {
  id: string;
  label: string;
  description?: string;
  tooltip?: string;
  iconId?: string;
  resourceUri?: string;
  collapsibleState: 0 | 1 | 2; // None | Collapsed | Expanded
  contextValue?: string;
  command?: { command: string; title: string };
}

export interface RuntimeCompletionItem {
  label: string;
  insertText?: string;
  detail?: string;
  documentation?: string;
  kind?: number;
}

export type RuntimeStatus = "stopped" | "starting" | "active" | "error";

export interface ExtensionRuntimeOptions {
  extensionId: string;
  installPath: string;
  mainPath: string;
  workspaceFolders: string[];
  configuration?: Record<string, unknown>;
  githubToken?: string;
  onStatus?: (status: RuntimeStatus, message?: string) => void;
  onHostError?: (message: string, stack?: string) => void;
  onViewRegistered?: (viewId: string, viewType: "tree" | "webview") => void;
  onTreeChanged?: (viewId: string) => void;
  onNotification?: (level: "info" | "warning" | "error", message: string) => void;
  onWebviewHtml?: (viewId: string, html: string) => void;
  onWebviewPostMessage?: (viewId: string, message: unknown) => void;
}

let _hostScript: string | null = null;
async function getHostScript(): Promise<string> {
  if (_hostScript) return _hostScript;
  _hostScript = await resolveResource("extension-host/host.cjs");
  return _hostScript;
}

function shouldIgnoreExtensionStderr(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return true;
  if (trimmed.includes("[DEP0040] DeprecationWarning: The `punycode` module is deprecated.")) return true;
  if (trimmed.includes("Use `node --trace-deprecation ...` to show where the warning was created")) return true;
  return false;
}

export class ExtensionRuntime {
  private process: Child | null = null;
  private status: RuntimeStatus = "stopped";
  private opts: ExtensionRuntimeOptions;
  private msgBuffer = "";
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingChildren = new Map<string, (nodes: TreeNode[]) => void>();
  private pendingCompletions = new Map<string, (items: RuntimeCompletionItem[]) => void>();
  private pendingTerminalLinks = new Map<string, (handled: boolean) => void>();
  private registeredViews = new Set<string>();
  private webviewViews = new Set<string>();
  private webviewHtml = new Map<string, string>();

  constructor(opts: ExtensionRuntimeOptions) {
    this.opts = opts;
  }

  getStatus(): RuntimeStatus { return this.status; }
  getRegisteredViews(): string[] { return [...this.registeredViews]; }
  isWebviewView(viewId: string): boolean { return this.webviewViews.has(viewId); }
  getWebviewHtml(viewId: string): string { return this.webviewHtml.get(viewId) ?? ""; }

  async start(): Promise<void> {
    if (this.process) await this.stop();
    this.setStatus("starting");

    try {
      const hostScript = await getHostScript();
      // GUI apps on macOS get a minimal PATH that excludes user-installed Node.js.
      // Spawn via sh with augmented PATH covering Homebrew (Intel+ARM), Volta, NVM,
      // and the pkg installer location so node is found regardless of install method.
      const nodeLookupPath = [
        "/usr/local/bin",
        "/opt/homebrew/bin",
        "/opt/homebrew/opt/node/bin",
        "${HOME}/.volta/bin",
        "${HOME}/.nvm/versions/node/$(ls \"${HOME}/.nvm/versions/node/\" 2>/dev/null | sort -rV | head -1)/bin",
        "${PATH}",
      ].join(":");
      const launchScript = [
        `PATH="${nodeLookupPath}"`,
        `pick_node() {`,
        `  for cand in "$ATHVA_NODE_BIN" /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.volta/bin/node" node; do`,
        `    [ -n "$cand" ] || continue`,
        `    command -v "$cand" >/dev/null 2>&1 || continue`,
        `    ver=$("$cand" -v 2>/dev/null)`,
        `    major=$(printf "%s" "$ver" | sed -E 's/^v([0-9]+).*/\\1/')`,
        `    case "$major" in`,
        `      ''|*[!0-9]*) ;;`,
        `      *)`,
        `        if [ "$major" -ge 22 ]; then`,
        `          printf "%s" "$cand"`,
        `          return 0`,
        `        fi`,
        `      ;;`,
        `    esac`,
        `  done`,
        `  command -v node 2>/dev/null || true`,
        `}`,
        `NODE_BIN=$(pick_node)`,
        `if [ -z "$NODE_BIN" ]; then`,
        `  echo "No Node.js runtime found for extension host" >&2`,
        `  exit 127`,
        `fi`,
        `exec "$NODE_BIN" "$@"`,
      ].join("\n");
      const cmd = Command.create(
        "sh",
        [
          "-c",
          launchScript,
          "--",
          hostScript,
          this.opts.mainPath,
          this.opts.extensionId,
          this.opts.installPath,
          JSON.stringify(this.opts.workspaceFolders || []),
        ],
        {
          env: this.opts.githubToken
            ? { ATHVA_GITHUB_TOKEN: this.opts.githubToken }
            : {},
        }
      );

      cmd.stdout.on("data", (line: string) => this.handleOutput(line));
      cmd.stderr.on("data", (line: string) => {
        if (shouldIgnoreExtensionStderr(line)) return;
        console.warn(`[ExtHost:${this.opts.extensionId}] stderr:`, line.trim());
      });
      cmd.on("close", (data) => {
        this.process = null;
        if (this.status !== "stopped") {
          this.setStatus("error", `Process exited with code ${data?.code ?? data}`);
        }
      });
      cmd.on("error", (err) => {
        this.process = null;
        this.setStatus("error", String(err));
      });

      this.process = await cmd.spawn();
      this.armStartupWatchdog();

      // Send initial workspace context
      this.send({
        type: "setWorkspace",
        folders: this.opts.workspaceFolders,
        configuration: this.opts.configuration ?? {},
      });
    } catch (e) {
      this.setStatus("error", String(e));
      throw e;
    }
  }

  async stop(): Promise<void> {
    this.setStatus("stopped");
    this.clearStartupWatchdog();
    if (this.process) {
      try { await this.process.kill(); } catch {}
      this.process = null;
    }
    this.registeredViews.clear();
    this.webviewViews.clear();
    this.webviewHtml.clear();
    this.pendingChildren.clear();
    this.pendingCompletions.clear();
  }

  async getChildren(viewId: string, elementId?: string): Promise<TreeNode[]> {
    if (!this.process || this.status !== "active") return [];
    return new Promise((resolve) => {
      const key = `${viewId}:${elementId ?? "root"}`;
      const timer = setTimeout(() => {
        this.pendingChildren.delete(key);
        resolve([]);
      }, 5000);
      this.pendingChildren.set(key, (nodes) => {
        clearTimeout(timer);
        resolve(nodes);
      });
      this.send({ type: "getChildren", viewId, elementId: elementId ?? null });
    });
  }

  async executeCommand(command: string, ...args: unknown[]): Promise<unknown> {
    if (!this.process) return undefined;
    const id = Math.random().toString(36).slice(2);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(undefined), 3000);
      const key = `cmd:${id}`;
      this.pendingChildren.set(key, (result: any) => {
        clearTimeout(timer);
        resolve(result);
      });
      this.send({ type: "executeCommand", id, command, args });
    });
  }

  async handleTerminalLink(uri: string): Promise<boolean> {
    if (!this.process || this.status !== "active") return false;
    const id = Math.random().toString(36).slice(2);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingTerminalLinks.delete(id);
        resolve(false);
      }, 2500);
      this.pendingTerminalLinks.set(id, (handled) => {
        clearTimeout(timer);
        resolve(handled);
      });
      this.send({ type: "terminalLink", id, uri });
    });
  }

  async provideCompletions(input: {
    filePath: string;
    content: string;
    lineNumber: number;
    column: number;
    languageId?: string;
  }): Promise<RuntimeCompletionItem[]> {
    if (!this.process || this.status !== "active") return [];
    const id = Math.random().toString(36).slice(2);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingCompletions.delete(id);
        resolve([]);
      }, 2500);
      this.pendingCompletions.set(id, (items) => {
        clearTimeout(timer);
        resolve(items);
      });
      this.send({
        type: "provideCompletions",
        id,
        filePath: input.filePath,
        content: input.content,
        lineNumber: input.lineNumber,
        column: input.column,
        languageId: input.languageId ?? "",
      });
    });
  }

  updateWorkspace(folders: string[], configuration?: Record<string, unknown>) {
    this.opts.workspaceFolders = folders;
    if (configuration) this.opts.configuration = configuration;
    if (this.process) {
      this.send({ type: "setWorkspace", folders, configuration: configuration ?? this.opts.configuration ?? {} });
    }
  }

  postWebviewMessage(viewId: string, message: unknown) {
    this.send({ type: "webviewMessage", viewId, message });
  }

  private send(msg: unknown) {
    if (!this.process) return;
    void this.process.write(JSON.stringify(msg) + "\n");
  }

  private handleOutput(chunk: string) {
    this.msgBuffer += chunk;
    const lines = this.msgBuffer.split("\n");
    this.msgBuffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        this.handleMessage(JSON.parse(trimmed));
      } catch {}
    }
  }

  private handleMessage(msg: Record<string, unknown>) {
    switch (msg.type) {
      case "activated":
        this.setStatus("active");
        break;

      case "error":
        {
          const message = typeof msg.message === "string" ? msg.message : String(msg.message ?? "Unknown error");
          const stack = typeof msg.stack === "string" && msg.stack.trim() ? msg.stack : undefined;
          if (stack) {
            console.error(`[ExtHost:${this.opts.extensionId}]`, message, "\n" + stack);
          } else {
            console.error(`[ExtHost:${this.opts.extensionId}]`, message);
          }
          this.opts.onHostError?.(message, stack);
          if (this.status !== "active") this.setStatus("error", message);
        }
        break;

      case "viewRegistered": {
        const vid = String(msg.viewId);
        const vtype = String(msg.viewType ?? "tree") as "tree" | "webview";
        this.registeredViews.add(vid);
        if (vtype === "webview") this.webviewViews.add(vid);
        this.opts.onViewRegistered?.(vid, vtype);
        break;
      }

      case "treeChanged":
        this.opts.onTreeChanged?.(String(msg.viewId));
        break;

      case "children": {
        const key = `${msg.viewId}:${msg.elementId ?? "root"}`;
        const resolve = this.pendingChildren.get(key);
        if (resolve) {
          this.pendingChildren.delete(key);
          resolve((msg.items ?? []) as TreeNode[]);
        }
        break;
      }

      case "commandResult": {
        const key = `cmd:${msg.id}`;
        const resolve = this.pendingChildren.get(key);
        if (resolve) {
          this.pendingChildren.delete(key);
          (resolve as any)(msg.result);
        }
        break;
      }

      case "completionResult": {
        const id = String(msg.id ?? "");
        const resolve = this.pendingCompletions.get(id);
        if (resolve) {
          this.pendingCompletions.delete(id);
          const items = Array.isArray(msg.items) ? (msg.items as RuntimeCompletionItem[]) : [];
          resolve(items);
        }
        break;
      }

      case "terminalLinkResult": {
        const id = String(msg.id ?? "");
        const resolve = this.pendingTerminalLinks.get(id);
        if (resolve) {
          this.pendingTerminalLinks.delete(id);
          resolve(Boolean(msg.handled));
        }
        break;
      }

      case "notification":
        this.opts.onNotification?.(
          (msg.level as "info" | "warning" | "error") ?? "info",
          String(msg.message)
        );
        break;

      case "webviewHtml": {
        const viewId = String(msg.viewId ?? "");
        const html = String(msg.html ?? "");
        if (!viewId) break;
        this.webviewHtml.set(viewId, html);
        this.opts.onWebviewHtml?.(viewId, html);
        break;
      }

      case "webviewPostMessage": {
        const viewId = String(msg.viewId ?? "");
        if (!viewId) break;
        this.opts.onWebviewPostMessage?.(viewId, msg.message);
        break;
      }

      case "openExternal":
        try {
          const uri = String(msg.uri ?? "");
          if (uri) window.open(uri, "_blank", "noopener,noreferrer");
        } catch {}
        break;
    }
  }

  private setStatus(status: RuntimeStatus, message?: string) {
    this.status = status;
    if (status === "active" || status === "error" || status === "stopped") {
      this.clearStartupWatchdog();
    }
    this.opts.onStatus?.(status, message);
  }

  private armStartupWatchdog() {
    this.clearStartupWatchdog();
    this.startupTimer = setTimeout(() => {
      if (this.status !== "starting") return;
      this.setStatus(
        "error",
        "Extension host did not activate within 15 seconds. This usually means the extension host or app-server is incompatible with Athva; check the extension logs for unsupported feature or webview errors. For Codex, `workspace_dependencies` mismatches are a common cause."
      );
    }, 15_000);
  }

  private clearStartupWatchdog() {
    if (!this.startupTimer) return;
    clearTimeout(this.startupTimer);
    this.startupTimer = null;
  }
}

// Registry: one runtime per extension identifier
const runtimeRegistry = new Map<string, ExtensionRuntime>();

export function getOrCreateRuntime(opts: ExtensionRuntimeOptions): ExtensionRuntime {
  if (runtimeRegistry.has(opts.extensionId)) return runtimeRegistry.get(opts.extensionId)!;
  const rt = new ExtensionRuntime(opts);
  runtimeRegistry.set(opts.extensionId, rt);
  return rt;
}

export function getRuntime(extensionId: string): ExtensionRuntime | undefined {
  return runtimeRegistry.get(extensionId);
}

export async function stopAllRuntimes() {
  for (const rt of runtimeRegistry.values()) await rt.stop();
  runtimeRegistry.clear();
}
