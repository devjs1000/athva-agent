import { getFileIcon } from "./file-icons";
import type { ContextWorkspaceModel } from "./context-manager";
import { ContextManager } from "./context-manager";

type ContextWorkspaceMode = "list" | "graph";

function escapeHtml(value: string): string {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
}

export class ContextsWorkspace {
  private model: ContextWorkspaceModel | null = null;
  private mode: ContextWorkspaceMode = "list";

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
            <p class="contexts-view-subtitle">Indexed context files with lightweight history references.</p>
          </div>
          <div class="contexts-view-actions">
            <button type="button" class="contexts-mode-btn${this.mode === "list" ? " active" : ""}" data-mode="list">List</button>
            <button type="button" class="contexts-mode-btn${this.mode === "graph" ? " active" : ""}" data-mode="graph">Graph</button>
          </div>
        </div>
        <div class="contexts-view-meta">
          <span class="contexts-meta-chip">${model.coreEntries.length} core files</span>
          <span class="contexts-meta-chip">${model.taskEntries.length} task records</span>
          <span class="contexts-meta-chip">Root: .athva/contexts</span>
        </div>
        <div class="contexts-view-body">
          ${this.mode === "list" ? listMarkup : graphMarkup}
        </div>
      </div>
    `;

    this.bind();
  }

  private renderList(model: ContextWorkspaceModel): string {
    const rows: string[] = [];

    rows.push(this.listItem("Context Index", model.indexPath, ".athva/contexts/context.md", "Index"));
    for (const entry of model.coreEntries) {
      rows.push(this.listItem(entry.name, this.contextManager.resolvePath(entry.path), entry.path, "Context"));
    }
    rows.push(this.listItem("Task History", model.taskHistoryPath, ".athva/contexts/task-history.md", "Index"));
    for (const entry of model.taskEntries) {
      rows.push(this.listItem(entry.title, this.contextManager.resolvePath(entry.path), entry.path, "Task"));
    }

    return `<div class="contexts-list">${rows.join("")}</div>`;
  }

  private listItem(label: string, absolutePath: string, relativePath: string, tag: string): string {
    const iconName = relativePath.split("/").pop() || relativePath;
    return `
      <button type="button" class="contexts-item" data-path="${escapeHtml(absolutePath)}" data-name="${escapeHtml(iconName)}">
        <span class="contexts-item-icon">${getFileIcon(iconName)}</span>
        <span class="contexts-item-copy">
          <span class="contexts-item-title">${escapeHtml(label)}</span>
          <span class="contexts-item-path">${escapeHtml(relativePath)}</span>
        </span>
        <span class="contexts-item-tag">${escapeHtml(tag)}</span>
      </button>
    `;
  }

  private renderGraph(model: ContextWorkspaceModel): string {
    const nodes: string[] = [];
    const edges: string[] = [];

    nodes.push(this.graphNode("Contexts", model.indexPath, 50, 14, "root"));
    nodes.push(this.graphNode("Task History", model.taskHistoryPath, 78, 28, "history-root"));
    edges.push(this.graphEdge(50, 14, 78, 28));

    const coreEntries = model.coreEntries.length ? model.coreEntries : [];
    const coreStep = coreEntries.length > 1 ? 56 / (coreEntries.length - 1) : 0;
    coreEntries.forEach((entry, index) => {
      const top = 24 + (coreStep * index);
      const left = index % 2 === 0 ? 20 : 28;
      const absolutePath = this.contextManager.resolvePath(entry.path);
      nodes.push(this.graphNode(entry.name, absolutePath, left, top, "context"));
      edges.push(this.graphEdge(50, 14, left, top));
    });

    const taskEntries = model.taskEntries.slice(0, 16);
    const historyStep = taskEntries.length > 1 ? 52 / (taskEntries.length - 1) : 0;
    taskEntries.forEach((entry, index) => {
      const top = 34 + (historyStep * index);
      const left = index % 2 === 0 ? 72 : 84;
      const absolutePath = this.contextManager.resolvePath(entry.path);
      nodes.push(this.graphNode(this.clip(entry.title, 28), absolutePath, left, top, "task"));
      edges.push(this.graphEdge(78, 28, left, top));
    });

    return `<div class="contexts-graph-canvas">${edges.join("")}${nodes.join("")}</div>`;
  }

  private graphNode(label: string, absolutePath: string, left: number, top: number, kind: string): string {
    const name = absolutePath.split("/").pop() || absolutePath;
    return `
      <button
        type="button"
        class="contexts-graph-node contexts-graph-node-${kind}"
        data-path="${escapeHtml(absolutePath)}"
        data-name="${escapeHtml(name)}"
        style="left:${left}%;top:${top}%"
      >${escapeHtml(label)}</button>
    `;
  }

  private graphEdge(fromLeft: number, fromTop: number, toLeft: number, toTop: number): string {
    const dx = toLeft - fromLeft;
    const dy = toTop - fromTop;
    const length = Math.sqrt((dx * dx) + (dy * dy));
    const angle = Math.atan2(dy, dx) * (180 / Math.PI);
    return `<div class="contexts-graph-edge" style="left:${fromLeft}%;top:${fromTop}%;width:${length}%;transform:rotate(${angle}deg)"></div>`;
  }

  private bind() {
    this.container.querySelectorAll<HTMLElement>(".contexts-mode-btn").forEach((button) => {
      button.addEventListener("click", () => {
        const mode = button.dataset.mode === "graph" ? "graph" : "list";
        this.setMode(mode);
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
}
