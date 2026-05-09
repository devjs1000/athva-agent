import { invoke } from "@tauri-apps/api/core";
import * as monaco from "monaco-editor";

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
type ApiTab = "body" | "headers" | "response" | "requests";

interface ApiRequestHistoryItem {
  id: string;
  name: string;
  method: HttpMethod;
  url: string;
  headersText: string;
  bodyText: string;
  createdAt: string;
  status?: number;
  durationMs?: number;
  error?: string;
}

interface ApiVarsEntry { key: string; value: string; }
interface ApiRequestsStore { variables: ApiVarsEntry[]; history: ApiRequestHistoryItem[]; }
interface NativeHttpResponse { status: number; status_text: string; headers: Record<string, string>; body: string; }

const STORE_RELATIVE_PATH = ".athva/api-requests.json";
const ENV_FILE_CANDIDATES = [".env", ".env.local", ".env.development", ".env.development.local", ".env.production", ".env.production.local", ".env.test", ".env.test.local"];
const MAX_HISTORY = 120;

function defaultStore(): ApiRequestsStore { return { variables: [], history: [] }; }
function createId(): string { return `api_req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`; }

function escapeHtml(value: string): string {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
}

function parseStore(raw: string): ApiRequestsStore {
  try {
    const parsed = JSON.parse(raw) as Partial<ApiRequestsStore>;
    return {
      variables: Array.isArray(parsed.variables) ? parsed.variables.filter(Boolean) as ApiVarsEntry[] : [],
      history: Array.isArray(parsed.history) ? parsed.history.filter(Boolean) as ApiRequestHistoryItem[] : [],
    };
  } catch { return defaultStore(); }
}

function parseEnvContent(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const noExport = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
    const eq = noExport.indexOf("=");
    if (eq <= 0) continue;
    const key = noExport.slice(0, eq).trim();
    let value = noExport.slice(eq + 1).trim();
    if (!key) continue;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}

function parseHeaders(input: string): Record<string, string> {
  const raw = input.trim();
  if (!raw) return {};
  if (raw.startsWith("{")) {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, String(v ?? "")]));
  }
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(":");
    if (idx <= 0) continue;
    out[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  }
  return out;
}

function mergeVariables(envVars: Record<string, string>, explicitVars: ApiVarsEntry[]): Record<string, string> {
  const merged: Record<string, string> = { ...envVars };
  for (const entry of explicitVars) {
    const key = entry.key.trim();
    if (key) merged[key] = entry.value ?? "";
  }
  return merged;
}

function interpolate(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (_m, key: string) => vars[key] ?? "");
}

export class ApiRequestsPanel {
  private readonly panelEl: HTMLElement;
  private readonly triggerBtn: HTMLButtonElement;
  private readonly closeBtn: HTMLButtonElement;
  private readonly sendBtn: HTMLButtonElement;
  private readonly refreshEnvBtn: HTMLButtonElement;
  private readonly methodEl: HTMLSelectElement;
  private readonly nameEl: HTMLInputElement;
  private readonly urlEl: HTMLInputElement;
  private readonly varsEl: HTMLTextAreaElement;
  private readonly envPreviewEl: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly responseMetaEl: HTMLElement;
  private readonly historyEl: HTMLElement;

  private bodyEditor!: monaco.editor.IStandaloneCodeEditor;
  private headersEditor!: monaco.editor.IStandaloneCodeEditor;
  private responseEditor!: monaco.editor.IStandaloneCodeEditor;

  private projectPath = "";
  private history: ApiRequestHistoryItem[] = [];
  private explicitVars: ApiVarsEntry[] = [];
  private envVars: Record<string, string> = {};

  constructor(panelId: string) {
    this.panelEl = document.getElementById(panelId)!;
    this.triggerBtn = document.getElementById("btn-toggle-api-requests") as HTMLButtonElement;
    this.closeBtn = document.getElementById("btn-close-api-requests") as HTMLButtonElement;
    this.sendBtn = document.getElementById("btn-send-api-request") as HTMLButtonElement;
    this.refreshEnvBtn = document.getElementById("btn-refresh-api-env") as HTMLButtonElement;
    this.methodEl = this.panelEl.querySelector(".api-req-method") as HTMLSelectElement;
    this.nameEl = this.panelEl.querySelector(".api-req-name") as HTMLInputElement;
    this.urlEl = this.panelEl.querySelector(".api-req-url") as HTMLInputElement;
    this.varsEl = this.panelEl.querySelector(".api-req-vars") as HTMLTextAreaElement;
    this.envPreviewEl = this.panelEl.querySelector(".api-req-env-preview") as HTMLElement;
    this.statusEl = this.panelEl.querySelector(".api-req-status") as HTMLElement;
    this.responseMetaEl = this.panelEl.querySelector(".api-req-response-meta") as HTMLElement;
    this.historyEl = this.panelEl.querySelector(".api-req-history") as HTMLElement;

    this.initEditors();
    this.bindTabs();

    this.closeBtn.addEventListener("click", () => this.hide());
    this.sendBtn.addEventListener("click", () => void this.sendRequest());
    this.refreshEnvBtn.addEventListener("click", () => void this.reloadEnvVars());
    this.varsEl.addEventListener("change", () => void this.saveVarsFromText());

    this.panelEl.addEventListener("click", (event) => {
      const pasteBtn = (event.target as HTMLElement).closest("[data-paste-target]") as HTMLElement | null;
      if (pasteBtn) { void this.pasteToInput(pasteBtn.dataset.pasteTarget!); return; }
    });

    this.panelEl.addEventListener("click", (event) => {
      const target = (event.target as HTMLElement).closest("[data-api-history-id]") as HTMLElement | null;
      if (!target) return;
      const id = target.dataset.apiHistoryId;
      const item = this.history.find((entry) => entry.id === id);
      if (!item) return;
      this.methodEl.value = item.method;
      this.nameEl.value = item.name;
      this.urlEl.value = item.url;
      this.headersEditor.setValue(item.headersText || "{}");
      this.bodyEditor.setValue(item.bodyText || "{}");
      this.statusEl.textContent = "Loaded request.";
    });

    this.headersEditor.setValue('{\n  "Content-Type": "application/json"\n}');
    this.bodyEditor.setValue('{}');
    this.render();
  }

  private initEditors() {
    const shared = {
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 12,
      lineNumbers: "on" as const,
      scrollBeyondLastLine: false,
    };

    this.bodyEditor = monaco.editor.create(document.getElementById("api-req-body-editor")!, {
      ...shared,
      language: "json",
      value: "{}",
    });

    this.headersEditor = monaco.editor.create(document.getElementById("api-req-headers-editor")!, {
      ...shared,
      language: "json",
      value: "{}",
    });

    this.responseEditor = monaco.editor.create(document.getElementById("api-req-response-editor")!, {
      ...shared,
      language: "json",
      value: "",
      readOnly: true,
    });
  }

  private bindTabs() {
    this.panelEl.querySelectorAll<HTMLElement>("[data-api-tab]").forEach((tabBtn) => {
      tabBtn.addEventListener("click", () => this.setTab(tabBtn.dataset.apiTab as ApiTab));
    });
  }

  private setTab(tab: ApiTab) {
    this.panelEl.querySelectorAll<HTMLElement>("[data-api-tab]").forEach((btn) => btn.classList.toggle("active", btn.dataset.apiTab === tab));
    this.panelEl.querySelectorAll<HTMLElement>("[data-api-panel]").forEach((panel) => panel.classList.toggle("active", panel.dataset.apiPanel === tab));
    setTimeout(() => {
      this.bodyEditor.layout();
      this.headersEditor.layout();
      this.responseEditor.layout();
    }, 0);
  }

  async setProjectPath(projectPath: string) {
    this.projectPath = projectPath;
    if (!projectPath) {
      this.history = [];
      this.explicitVars = [];
      this.envVars = {};
      this.render();
      return;
    }
    await this.loadStore();
    await this.reloadEnvVars();
    this.render();
  }

  show() {
    this.panelEl.classList.remove("hidden");
    document.getElementById("api-requests-resize")?.classList.remove("hidden");
    this.triggerBtn.classList.add("active");
    setTimeout(() => {
      this.bodyEditor.layout();
      this.headersEditor.layout();
      this.responseEditor.layout();
    }, 0);
  }

  hide() {
    this.panelEl.classList.add("hidden");
    document.getElementById("api-requests-resize")?.classList.add("hidden");
    this.triggerBtn.classList.remove("active");
  }

  toggle() { this.isVisible() ? this.hide() : this.show(); }
  isVisible(): boolean { return !this.panelEl.classList.contains("hidden"); }

  private async loadStore() {
    if (!this.projectPath) return;
    try {
      const raw = await invoke<string>("read_file", { path: `${this.projectPath}/${STORE_RELATIVE_PATH}` });
      const parsed = parseStore(raw);
      this.history = parsed.history;
      this.explicitVars = parsed.variables;
      this.varsEl.value = this.explicitVars.map((entry) => `${entry.key}=${entry.value}`).join("\n");
    } catch {
      this.history = [];
      this.explicitVars = [];
      this.varsEl.value = "";
    }
  }

  private async saveStore() {
    if (!this.projectPath) return;
    await invoke("create_dir", { path: `${this.projectPath}/.athva` }).catch(() => {});
    await invoke("write_file", {
      path: `${this.projectPath}/${STORE_RELATIVE_PATH}`,
      content: JSON.stringify({ variables: this.explicitVars, history: this.history }, null, 2),
    });
  }

  private async saveVarsFromText() {
    const next: ApiVarsEntry[] = [];
    for (const line of this.varsEl.value.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx <= 0) continue;
      next.push({ key: trimmed.slice(0, idx).trim(), value: trimmed.slice(idx + 1).trim() });
    }
    this.explicitVars = next;
    await this.saveStore();
    this.renderEnvPreview();
  }

  private async reloadEnvVars() {
    if (!this.projectPath) return;
    const merged: Record<string, string> = {};
    for (const name of ENV_FILE_CANDIDATES) {
      try {
        const raw = await invoke<string>("read_file", { path: `${this.projectPath}/${name}` });
        Object.assign(merged, parseEnvContent(raw));
      } catch {
        // ignore missing files
      }
    }
    this.envVars = merged;
    this.renderEnvPreview();
  }

  private renderEnvPreview() {
    const merged = mergeVariables(this.envVars, this.explicitVars);
    const names = Object.keys(merged).sort((a, b) => a.localeCompare(b));
    this.envPreviewEl.innerHTML = names.length
      ? names.slice(0, 60).map((name) => `<code>${escapeHtml(name)}</code>`).join(" ")
      : "No env/explicit variables detected.";
  }

  private renderHistory() {
    if (!this.history.length) {
      this.historyEl.innerHTML = `<div class="api-req-empty">No requests yet.</div>`;
      return;
    }
    this.historyEl.innerHTML = this.history.map((item) => {
      const status = item.error ? `ERR ${item.error}` : item.status ? String(item.status) : "-";
      const duration = typeof item.durationMs === "number" ? `${item.durationMs}ms` : "";
      return `
        <button class="api-req-history-item" data-api-history-id="${item.id}" type="button">
          <span class="api-req-history-top">
            <span class="api-req-chip">${item.method}</span>
            <span class="api-req-history-name">${escapeHtml(item.name || item.url)}</span>
          </span>
          <span class="api-req-history-meta">${escapeHtml(status)} ${escapeHtml(duration)} · ${new Date(item.createdAt).toLocaleString()}</span>
        </button>
      `;
    }).join("");
  }

  private render() {
    this.renderEnvPreview();
    this.renderHistory();
  }

  private async pasteToInput(target: string) {
    try {
      const text = await navigator.clipboard.readText();
      if (!text) return;
      if (target === "name") { this.nameEl.value = text; }
      else if (target === "url") { this.urlEl.value = text; }
      else if (target === "vars") { this.varsEl.value = text; void this.saveVarsFromText(); }
    } catch { /* clipboard access denied */ }
  }

  private async sendRequest() {
    const method = (this.methodEl.value || "GET") as HttpMethod;
    const name = this.nameEl.value.trim();
    const vars = mergeVariables(this.envVars, this.explicitVars);
    const url = interpolate(this.urlEl.value.trim(), vars);
    const headersText = interpolate(this.headersEditor.getValue(), vars);
    const bodyText = interpolate(this.bodyEditor.getValue(), vars);

    if (!url) {
      this.statusEl.textContent = "Request URL is required.";
      return;
    }

    this.statusEl.textContent = `Sending ${method} ${url} ...`;
    this.responseMetaEl.textContent = "";
    this.responseEditor.setValue("");

    const started = performance.now();
    let historyItem: ApiRequestHistoryItem = {
      id: createId(),
      name: name || `${method} ${url}`,
      method,
      url: this.urlEl.value.trim(),
      headersText: this.headersEditor.getValue(),
      bodyText: this.bodyEditor.getValue(),
      createdAt: new Date().toISOString(),
    };

    try {
      const headers = parseHeaders(headersText);
      const response = await invoke<NativeHttpResponse>("http_request", {
        payload: { method, url, headers, body: !["GET", "HEAD"].includes(method) ? bodyText : "" },
      });

      const durationMs = Math.round(performance.now() - started);
      const ct = Object.entries(response.headers).find(([k]) => k.toLowerCase() === "content-type")?.[1] || "";
      let formatted = response.body || "(empty response body)";
      if (ct.includes("application/json")) {
        try { formatted = JSON.stringify(JSON.parse(response.body), null, 2); } catch {}
      }
      this.responseEditor.setValue(formatted);
      this.responseMetaEl.textContent = `${method} ${url} · ${response.status} ${response.status_text} · ${durationMs}ms`;
      this.statusEl.textContent = `Request completed: ${response.status} ${response.status_text}`;
      this.setTab("response");
      historyItem = { ...historyItem, status: response.status, durationMs };
    } catch (error) {
      const durationMs = Math.round(performance.now() - started);
      const rawMessage = error instanceof Error ? error.message : String(error);
      const lower = rawMessage.toLowerCase();
      const hint = (lower.includes("not allowed") || lower.includes("unknown") || lower.includes("http_request"))
        ? "\nHint: restart the app after updating Tauri permissions/build."
        : "";
      const message = `${rawMessage}${hint}`;
      this.responseEditor.setValue(message);
      this.responseMetaEl.textContent = `${method} ${url} · ${durationMs}ms`;
      this.statusEl.textContent = `Request failed: ${rawMessage}`;
      this.setTab("response");
      historyItem = { ...historyItem, error: rawMessage, durationMs };
    }

    this.history = [historyItem, ...this.history].slice(0, MAX_HISTORY);
    await this.saveStore();
    this.renderHistory();
  }
}
