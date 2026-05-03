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

  constructor(
    private readonly container: HTMLElement,
    private readonly contextManager: ContextManager,
    private readonly onOpenFile: (path: string, name: string) => void,
  ) { }

  async render(): Promise<void> {
    this.model = await this.contextManager.buildWorkspaceModel();
    this.draw();
  }

  async reload(): Promise<void> {
    await this.render();
  }

  setMode(mode: ContextWorkspaceMode) {
    this.mode = mode;
    this.draw();
  }

  private draw() {
    const model = this.model;
    if (!model) {
      this.container.innerHTML = "";
      return;
    }

    const listMarkup = this.renderList(model);
    const graphMarkup = this.renderGraph(model);

    this.container.innerHTML = `
      <div class="contexts-view-shell">
        <div class="contexts-view-header">
          <div class="contexts-view-header-copy">
            <div class="contexts-view-kicker">ATHVA CONTEXTS</div>
            <h2 class="contexts-view-title">Contexts</h2>
            <p class="contexts-view-subtitle">Reference-aware context graph with session and task lineage.</p>
          </div>
          <div class="contexts-view-actions">
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
        <div class="contexts-view-body">
          ${this.mode === "list" ? listMarkup : graphMarkup}
        </div>
      </div>
    `;

    this.bind();
  }

  private renderList(model: ContextWorkspaceModel): string {
    const rows = model.documents.map((doc) => this.listItem(doc));
    return `<div class="contexts-list">${rows.join("")}</div>`;
  }

  private listItem(doc: ContextDocument): string {
    const iconName = doc.path.split("/").pop() || doc.path;
    const criticalBadge = doc.critical ? `<span class="contexts-item-critical">Critical</span>` : "";
    return `
      <button type="button" class="contexts-item" data-path="${escapeHtml(doc.absolutePath)}" data-name="${escapeHtml(iconName)}">
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
    const nodes = visibleDocs.map((doc, index) => this.graphNode(doc, index)).join("");
    const visibleIds = new Set(visibleDocs.map((doc) => doc.id));
    const edges = model.edges
      .filter((edge) => visibleIds.has(edge.from) && visibleIds.has(edge.to))
      .map((edge) => this.graphEdge(edge, visibleDocs))
      .join("");

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
          <div class="contexts-graph-canvas" style="transform:scale(${this.zoom})">
            <svg class="contexts-graph-svg" viewBox="0 0 1000 760" preserveAspectRatio="none">
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

  private filterButton(key: GraphFilterKey, label: string): string {
    return `<button type="button" class="contexts-mode-btn${this.filters[key] ? " active" : ""}" data-filter="${key}">${label}</button>`;
  }

  private graphNode(doc: ContextDocument, index: number): string {
    const position = this.positionForNode(doc, index);
    const name = doc.absolutePath.split("/").pop() || doc.absolutePath;
    const criticalClass = doc.critical ? " contexts-graph-node-critical" : "";
    const label = doc.references.length > 0 ? `${doc.name} (${doc.references.length})` : doc.name;
    return `
      <button
        type="button"
        class="contexts-graph-node contexts-graph-node-${graphGroup(doc.kind)}${criticalClass}"
        data-path="${escapeHtml(doc.absolutePath)}"
        data-name="${escapeHtml(name)}"
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
    const itemsInLane = (this.model?.documents.filter((item) => this.filters[graphGroup(item.kind)] && graphGroup(item.kind) === lane).length || 1);
    const laneIndex = (this.model?.documents.filter((item) => this.filters[graphGroup(item.kind)] && graphGroup(item.kind) === lane).findIndex((item) => item.id === doc.id) ?? index);
    const leftMap: Record<GraphFilterKey, number> = { context: 180, session: 500, task: 820 };
    const top = 100 + ((laneIndex + 1) * (560 / (itemsInLane + 1)));
    const drift = ((index % 2) * 44) - 22;
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
        if (mode === "graph" || mode === "list") {
          this.setMode(mode);
          return;
        }
        if (filter) {
          this.filters[filter] = !this.filters[filter];
          this.draw();
          return;
        }
        if (zoom === "in") this.zoom = Math.min(1.8, this.zoom + 0.15);
        if (zoom === "out") this.zoom = Math.max(0.55, this.zoom - 0.15);
        if (zoom === "reset") this.zoom = 1;
        this.draw();
      });
    });

    this.container.querySelectorAll<HTMLElement>("[data-path]").forEach((button) => {
      button.addEventListener("click", () => {
        const path = button.dataset.path;
        const name = button.dataset.name;
        if (!path || !name) return;
        this.onOpenFile(path, name);
      });
    });
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
}
