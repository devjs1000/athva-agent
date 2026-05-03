import { getFileIcon } from "./file-icons";
import type { ContextDocument, ContextGraphEdge, ContextWorkspaceModel } from "./context-manager";
import { ContextManager } from "./context-manager";
import { showConfirmDialog } from "./dialogs";

type ContextWorkspaceMode = "list" | "graph";
type GraphFilterKey = "context" | "session" | "task";

function escapeHtml(value: string): string {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
}

function kindLabel(kind: ContextDocument["kind"]): string {
  switch (kind) {
    case "session":
    case "session-index":
      return "Session";
    case "task":
    case "task-index":
      return "Task";
    case "index":
      return "Index";
    default:
      return "Context";
  }
}

function graphGroup(kind: ContextDocument["kind"]): GraphFilterKey {
  if (kind === "task" || kind === "task-index") return "task";
  if (kind === "session" || kind === "session-index") return "session";
  return "context";
}

export class ContextsWorkspace {
  private model: ContextWorkspaceModel | null = null;
  private mode: ContextWorkspaceMode = "list";
  private zoom = 1;
  private filters: Record<GraphFilterKey, boolean> = {
    context: true,
    session: true,
    task: true,
  };
  private selectedPath = "";
  private previewContent = "";

  constructor(
    private readonly container: HTMLElement,
    private readonly contextManager: ContextManager,
    private readonly onOpenFile: (path: string, name: string) => void,
  ) { }

  async render(): Promise<void> {
    this.model = await this.contextManager.buildWorkspaceModel();
    await this.ensurePreviewSelection();
    this.draw();
  }

  async reload(): Promise<void> {
    await this.render();
  }

  setMode(mode: ContextWorkspaceMode) {
    this.mode = mode;
    this.draw();
  }

  private async ensurePreviewSelection() {
    const docs = this.model?.documents || [];
    if (!docs.length) {
      this.selectedPath = "";
      this.previewContent = "";
      return;
    }
    const selected = docs.find((doc) => doc.path === this.selectedPath) || docs[0];
    this.selectedPath = selected.path;
    this.previewContent = await this.contextManager.readDocument(selected.absolutePath);
  }

  private draw() {
    const model = this.model;
    if (!model) {
      this.container.innerHTML = "";
      return;
    }

    const activeDoc = model.documents.find((doc) => doc.path === this.selectedPath) || null;
    const mainMarkup = this.mode === "list" ? this.renderList(model) : this.renderGraph(model);
    const previewMarkup = this.renderPreview(activeDoc);

    this.container.innerHTML = `
      <div class="contexts-view-shell">
        <div class="contexts-view-header">
          <div class="contexts-view-header-copy">
            <div class="contexts-view-kicker">ATHVA CONTEXTS</div>
            <h2 class="contexts-view-title">Contexts</h2>
            <p class="contexts-view-subtitle">Reference-aware context graph with inline preview and session/task lineage.</p>
          </div>
          <div class="contexts-view-actions">
            <button type="button" class="contexts-mode-btn" data-action="init">Init</button>
            <button type="button" class="contexts-mode-btn" data-action="compact">Compact</button>
            <button type="button" class="contexts-mode-btn" data-action="reset">Reset</button>
            <button type="button" class="contexts-mode-btn${this.mode === "list" ? " active" : ""}" data-mode="list">List</button>
            <button type="button" class="contexts-mode-btn${this.mode === "graph" ? " active" : ""}" data-mode="graph">Graph</button>
          </div>
        </div>
        <div class="contexts-view-meta">
          <span class="contexts-meta-chip">${model.documents.filter((doc) => graphGroup(doc.kind) === "context").length} contexts</span>
          <span class="contexts-meta-chip">${model.documents.filter((doc) => graphGroup(doc.kind) === "session").length} sessions</span>
          <span class="contexts-meta-chip">${model.documents.filter((doc) => graphGroup(doc.kind) === "task").length} tasks</span>
          <span class="contexts-meta-chip">${model.edges.length} links</span>
        </div>
        <div class="contexts-view-body contexts-view-body-split">
          <div class="contexts-view-main">${mainMarkup}</div>
          <aside class="contexts-preview-panel">${previewMarkup}</aside>
        </div>
      </div>
    `;

    this.bind();
  }

  private renderList(model: ContextWorkspaceModel): string {
    return `<div class="contexts-list">${model.documents.map((doc) => this.listItem(doc)).join("")}</div>`;
  }

  private listItem(doc: ContextDocument): string {
    const iconName = doc.path.split("/").pop() || doc.path;
    const criticalBadge = doc.critical ? `<span class="contexts-item-critical">Critical</span>` : "";
    const activeClass = doc.path === this.selectedPath ? " active" : "";
    return `
      <button type="button" class="contexts-item${activeClass}" data-select-path="${escapeHtml(doc.path)}">
        <span class="contexts-item-icon">${getFileIcon(iconName)}</span>
        <span class="contexts-item-copy">
          <span class="contexts-item-title">${escapeHtml(doc.name)}</span>
          <span class="contexts-item-path">${escapeHtml(doc.path)}</span>
        </span>
        ${criticalBadge}
        <span class="contexts-item-tag">${escapeHtml(kindLabel(doc.kind))}</span>
      </button>
    `;
  }

  private renderGraph(model: ContextWorkspaceModel): string {
    const visibleDocs = model.documents.filter((doc) => this.filters[graphGroup(doc.kind)]);
    const visibleIds = new Set(visibleDocs.map((doc) => doc.id));
    const { width, height } = this.contextManager.getGraphBaseSize();
    const scaledWidth = Math.round(width * this.zoom);
    const scaledHeight = Math.round(height * this.zoom);
    const edges = model.edges
      .filter((edge) => visibleIds.has(edge.from) && visibleIds.has(edge.to))
      .map((edge) => this.graphEdge(edge, visibleDocs))
      .join("");
    const nodes = visibleDocs.map((doc, index) => this.graphNode(doc, index)).join("");

    return `
      <div class="contexts-graph-shell">
        <div class="contexts-graph-toolbar">
          <div class="contexts-graph-filters">
            ${this.filterButton("context", "Contexts")}
            ${this.filterButton("session", "Sessions")}
            ${this.filterButton("task", "Tasks")}
          </div>
          <div class="contexts-graph-zoom">
            <button type="button" class="contexts-mode-btn" data-zoom="out">-</button>
            <button type="button" class="contexts-mode-btn" data-zoom="reset">${Math.round(this.zoom * 100)}%</button>
            <button type="button" class="contexts-mode-btn" data-zoom="in">+</button>
          </div>
        </div>
        <div class="contexts-graph-viewport">
          <div class="contexts-graph-canvas" style="width:${scaledWidth}px;height:${scaledHeight}px">
            <svg class="contexts-graph-svg" viewBox="0 0 ${scaledWidth} ${scaledHeight}" preserveAspectRatio="none">
              <defs>
                <marker id="contexts-arrow-end" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
                  <path d="M0,0 L8,4 L0,8 z" fill="rgba(124, 227, 196, 0.75)"></path>
                </marker>
                <marker id="contexts-arrow-start" markerWidth="8" markerHeight="8" refX="1" refY="4" orient="auto">
                  <path d="M8,0 L0,4 L8,8 z" fill="rgba(124, 227, 196, 0.75)"></path>
                </marker>
              </defs>
              ${edges}
            </svg>
            ${nodes}
          </div>
        </div>
      </div>
    `;
  }

  private renderPreview(doc: ContextDocument | null): string {
    if (!doc) {
      return `<div class="contexts-preview-empty">No context selected.</div>`;
    }

    const references = doc.references.length ? doc.references.map((ref) => `<span class="contexts-meta-chip">${escapeHtml(ref)}</span>`).join("") : `<span class="contexts-meta-chip">No references</span>`;
    return `
      <div class="contexts-preview-header">
        <div>
          <div class="contexts-preview-title">${escapeHtml(doc.name)}</div>
          <div class="contexts-preview-path">${escapeHtml(doc.path)}</div>
        </div>
        <button type="button" class="contexts-mode-btn" data-open-path="${escapeHtml(doc.absolutePath)}" data-open-name="${escapeHtml(doc.absolutePath.split("/").pop() || doc.name)}">Open</button>
      </div>
      <div class="contexts-preview-meta">
        <span class="contexts-meta-chip">${escapeHtml(kindLabel(doc.kind))}</span>
        <span class="contexts-meta-chip">${Math.max(1, Math.round(doc.sizeBytes / 1024))}KB</span>
        ${doc.critical ? '<span class="contexts-meta-chip">Critical</span>' : ""}
      </div>
      <div class="contexts-preview-summary">${escapeHtml(doc.summary || "No summary available.")}</div>
      <div class="contexts-preview-links">${references}</div>
      <pre class="contexts-preview-content">${escapeHtml(this.previewContent || "")}</pre>
    `;
  }

  private filterButton(key: GraphFilterKey, label: string): string {
    return `<button type="button" class="contexts-mode-btn${this.filters[key] ? " active" : ""}" data-filter="${key}">${label}</button>`;
  }

  private graphNode(doc: ContextDocument, index: number): string {
    const position = this.positionForNode(doc, index);
    const criticalClass = doc.critical ? " contexts-graph-node-critical" : "";
    const activeClass = doc.path === this.selectedPath ? " active" : "";
    const label = doc.references.length > 0 ? `${doc.name} (${doc.references.length})` : doc.name;
    return `
      <button
        type="button"
        class="contexts-graph-node contexts-graph-node-${graphGroup(doc.kind)}${criticalClass}${activeClass}"
        data-select-path="${escapeHtml(doc.path)}"
        style="left:${position.left}px;top:${position.top}px"
        title="${escapeHtml(doc.path)}"
      >${escapeHtml(this.clip(label, 32))}</button>
    `;
  }

  private graphEdge(edge: ContextGraphEdge, docs: ContextDocument[]): string {
    const fromIndex = docs.findIndex((doc) => doc.id === edge.from);
    const toIndex = docs.findIndex((doc) => doc.id === edge.to);
    if (fromIndex === -1 || toIndex === -1) return "";
    const from = this.positionForNode(docs[fromIndex], fromIndex);
    const to = this.positionForNode(docs[toIndex], toIndex);
    return `<line class="contexts-graph-edge-line" x1="${from.left}" y1="${from.top}" x2="${to.left}" y2="${to.top}" marker-end="url(#contexts-arrow-end)"${edge.bidirectional ? ` marker-start="url(#contexts-arrow-start)"` : ""}></line>`;
  }

  private positionForNode(doc: ContextDocument, index: number): { left: number; top: number } {
    const lane = graphGroup(doc.kind);
    const itemsInLane = this.model?.documents.filter((item) => this.filters[graphGroup(item.kind)] && graphGroup(item.kind) === lane) || [];
    const laneIndex = Math.max(0, itemsInLane.findIndex((item) => item.id === doc.id));
    const base = this.contextManager.getGraphBaseSize();
    const scaled = { width: base.width * this.zoom, height: base.height * this.zoom };
    const leftMap: Record<GraphFilterKey, number> = {
      context: scaled.width * 0.18,
      session: scaled.width * 0.50,
      task: scaled.width * 0.82,
    };
    const top = (scaled.height * 0.12) + ((laneIndex + 1) * ((scaled.height * 0.72) / (itemsInLane.length + 1)));
    const drift = ((index % 2) * 52 - 26) * this.zoom;
    return { left: leftMap[lane], top: top + drift };
  }

  private bind() {
    this.container.querySelectorAll<HTMLElement>(".contexts-mode-btn").forEach((button) => {
      button.addEventListener("click", () => {
        const mode = button.dataset.mode;
        const filter = button.dataset.filter as GraphFilterKey | undefined;
        const zoom = button.dataset.zoom;
        const action = button.dataset.action;
        if (action === "reset") {
          void this.resetContexts();
          return;
        }
        if (action === "init") {
          void this.initContexts();
          return;
        }
        if (action === "compact") {
          void this.compactContexts();
          return;
        }
        if (mode === "graph" || mode === "list") {
          this.setMode(mode);
          return;
        }
        if (filter) {
          this.filters[filter] = !this.filters[filter];
          this.draw();
          return;
        }
        if (zoom === "in") this.zoom = Math.min(2, this.zoom + 0.2);
        if (zoom === "out") this.zoom = Math.max(0.7, this.zoom - 0.2);
        if (zoom === "reset") this.zoom = 1;
        this.draw();
      });
    });

    this.container.querySelectorAll<HTMLElement>("[data-select-path]").forEach((button) => {
      button.addEventListener("click", () => {
        const path = button.dataset.selectPath;
        if (!path) return;
        void this.selectPath(path);
      });
    });

    this.container.querySelectorAll<HTMLElement>("[data-open-path]").forEach((button) => {
      button.addEventListener("click", () => {
        const path = button.dataset.openPath;
        const name = button.dataset.openName;
        if (!path || !name) return;
        this.onOpenFile(path, name);
      });
    });
  }

  private async selectPath(path: string) {
    this.selectedPath = path;
    this.previewContent = await this.contextManager.readDocument(path);
    this.draw();
  }

  private clip(value: string, limit: number): string {
    return value.length > limit ? `${value.slice(0, limit)}…` : value;
  }

  private async resetContexts() {
    const ok = await showConfirmDialog(
      "Reset Contexts",
      "Clear everything in the contexts folder and rebuild the default context files? This cannot be undone.",
      "Reset",
      "Cancel",
    );
    if (!ok) return;
    await this.contextManager.resetContexts();
    await this.reload();
  }

  private async initContexts() {
    await this.contextManager.initContexts();
    await this.reload();
  }

  private async compactContexts() {
    await this.contextManager.compactContexts();
    await this.reload();
  }
}
