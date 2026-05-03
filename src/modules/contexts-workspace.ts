import { getFileIcon } from "./file-icons";
import type { ContextWorkspaceModel } from "./context-manager";
import { ContextManager } from "./context-manager";

type ContextWorkspaceMode = "list" | "graph";

export class ContextsWorkspace {
  private panel: HTMLElement;
  private titleEl: HTMLElement;
  private emptyEl: HTMLElement;
  private listEl: HTMLElement;
  private graphEl: HTMLElement;
  private listBtn: HTMLButtonElement;
  private graphBtn: HTMLButtonElement;
  private closeBtn: HTMLButtonElement | null;
  private contextManager: ContextManager;
  private onOpenFile: (path: string, name: string) => void;
  private rootPath = "";
  private activePath = "";
  private mode: ContextWorkspaceMode = "list";
  private model: ContextWorkspaceModel | null = null;

  constructor(
    panelId: string,
    titleId: string,
    emptyId: string,
    listId: string,
    graphId: string,
    listBtnId: string,
    graphBtnId: string,
    contextManager: ContextManager,
    onOpenFile: (path: string, name: string) => void,
  ) {
    this.panel = document.getElementById(panelId)!;
    this.titleEl = document.getElementById(titleId)!;
    this.emptyEl = document.getElementById(emptyId)!;
    this.listEl = document.getElementById(listId)!;
    this.graphEl = document.getElementById(graphId)!;
    this.listBtn = document.getElementById(listBtnId) as HTMLButtonElement;
    this.graphBtn = document.getElementById(graphBtnId) as HTMLButtonElement;
    this.closeBtn = document.getElementById("btn-close-contexts-sidebar") as HTMLButtonElement | null;
    this.contextManager = contextManager;
    this.onOpenFile = onOpenFile;

    this.listBtn.addEventListener("click", () => this.setMode("list"));
    this.graphBtn.addEventListener("click", () => this.setMode("graph"));
    this.closeBtn?.addEventListener("click", () => this.close());
  }

  async openRoot(rootPath: string): Promise<void> {
    this.rootPath = rootPath;
    this.titleEl.textContent = "Contexts";
    this.panel.classList.remove("hidden");
    await this.reload();
  }

  async reload(): Promise<void> {
    if (!this.rootPath) return;
    this.model = await this.contextManager.buildWorkspaceModel();
    this.render();
  }

  close() {
    this.rootPath = "";
    this.activePath = "";
    this.model = null;
    this.panel.classList.add("hidden");
    this.listEl.innerHTML = "";
    this.graphEl.innerHTML = "";
  }

  isOpen(): boolean {
    return !this.panel.classList.contains("hidden");
  }

  containsPath(path: string): boolean {
    return !!this.rootPath && (path === this.rootPath || path.startsWith(`${this.rootPath}/`));
  }

  getRootPath(): string {
    return this.rootPath;
  }

  setActivePath(path: string) {
    this.activePath = path;
    this.listEl.querySelectorAll<HTMLElement>(".contexts-item").forEach((el) => {
      el.classList.toggle("active", el.dataset.path === path);
    });
    this.graphEl.querySelectorAll<HTMLElement>(".contexts-graph-node").forEach((el) => {
      el.classList.toggle("active", el.dataset.path === path);
    });
  }

  private setMode(mode: ContextWorkspaceMode) {
    this.mode = mode;
    this.listBtn.classList.toggle("active", mode === "list");
    this.graphBtn.classList.toggle("active", mode === "graph");
    this.listEl.classList.toggle("hidden", mode !== "list");
    this.graphEl.classList.toggle("hidden", mode !== "graph");
  }

  private render() {
    const model = this.model;
    if (!model) return;

    const hasItems = model.coreEntries.length > 0 || model.taskEntries.length > 0;
    this.emptyEl.classList.toggle("hidden", hasItems);
    this.listEl.innerHTML = "";
    this.graphEl.innerHTML = "";
    if (!hasItems) return;

    this.renderList(model);
    this.renderGraph(model);
    this.setMode(this.mode);
    if (this.activePath) this.setActivePath(this.activePath);
  }

  private renderList(model: ContextWorkspaceModel) {
    this.listEl.appendChild(this.buildItem("Context Index", model.indexPath, ".athva/contexts/context.md"));

    for (const entry of model.coreEntries) {
      this.listEl.appendChild(this.buildItem(entry.name, this.absolutePath(entry.path), entry.path));
    }

    this.listEl.appendChild(this.buildItem("Task History", model.taskHistoryPath, ".athva/contexts/task-history.md"));

    for (const entry of model.taskEntries.slice(0, 48)) {
      this.listEl.appendChild(this.buildItem(entry.title, this.absolutePath(entry.path), entry.path, "history"));
    }
  }

  private buildItem(label: string, absolutePath: string, relativePath: string, kind: "context" | "history" = "context"): HTMLElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "contexts-item";
    button.dataset.path = absolutePath;
    button.innerHTML = `
      <span class="contexts-item-icon">${getFileIcon(relativePath.split("/").pop() || relativePath)}</span>
      <span class="contexts-item-copy">
        <span class="contexts-item-title">${this.escapeHtml(label)}</span>
        <span class="contexts-item-path">${this.escapeHtml(relativePath)}</span>
      </span>
      <span class="contexts-item-tag">${kind === "history" ? "Task" : "Context"}</span>
    `;
    button.addEventListener("click", () => {
      this.activePath = absolutePath;
      this.setActivePath(absolutePath);
      this.onOpenFile(absolutePath, absolutePath.split("/").pop() || absolutePath);
    });
    return button;
  }

  private renderGraph(model: ContextWorkspaceModel) {
    const rootNode = this.buildGraphNode("Contexts", model.indexPath, 50, 16, "root");
    this.graphEl.appendChild(rootNode);

    const taskHistoryNode = this.buildGraphNode("Task History", model.taskHistoryPath, 78, 30, "history-root");
    this.graphEl.appendChild(taskHistoryNode);
    this.graphEl.appendChild(this.buildEdge(50, 16, 78, 30));

    const coreStep = model.coreEntries.length > 1 ? 60 / (model.coreEntries.length - 1) : 0;
    model.coreEntries.forEach((entry, index) => {
      const top = 26 + (coreStep * index);
      const left = 22 + (index % 2 === 0 ? 0 : 4);
      const node = this.buildGraphNode(entry.name, this.absolutePath(entry.path), left, top, "context");
      this.graphEl.appendChild(node);
      this.graphEl.appendChild(this.buildEdge(50, 16, left, top));
    });

    const historyEntries = model.taskEntries.slice(0, 12);
    const historyStep = historyEntries.length > 1 ? 56 / (historyEntries.length - 1) : 0;
    historyEntries.forEach((entry, index) => {
      const top = 36 + (historyStep * index);
      const left = 74 + (index % 2 === 0 ? 8 : 0);
      const node = this.buildGraphNode(this.clip(entry.title, 24), this.absolutePath(entry.path), left, top, "history");
      this.graphEl.appendChild(node);
      this.graphEl.appendChild(this.buildEdge(78, 30, left, top));
    });
  }

  private buildGraphNode(label: string, absolutePath: string, left: number, top: number, kind: string): HTMLElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `contexts-graph-node contexts-graph-node-${kind}`;
    button.dataset.path = absolutePath;
    button.style.left = `${left}%`;
    button.style.top = `${top}%`;
    button.textContent = label;
    button.addEventListener("click", () => {
      this.activePath = absolutePath;
      this.setActivePath(absolutePath);
      this.onOpenFile(absolutePath, absolutePath.split("/").pop() || absolutePath);
    });
    return button;
  }

  private buildEdge(fromLeft: number, fromTop: number, toLeft: number, toTop: number): HTMLElement {
    const dx = toLeft - fromLeft;
    const dy = toTop - fromTop;
    const length = Math.sqrt((dx * dx) + (dy * dy));
    const angle = Math.atan2(dy, dx) * (180 / Math.PI);

    const edge = document.createElement("div");
    edge.className = "contexts-graph-edge";
    edge.style.left = `${fromLeft}%`;
    edge.style.top = `${fromTop}%`;
    edge.style.width = `${length}%`;
    edge.style.transform = `rotate(${angle}deg)`;
    return edge;
  }

  private absolutePath(relativePath: string): string {
    const projectRoot = this.rootPath.replace(/\/\.athva\/contexts\/?$/, "");
    const normalized = relativePath.replace(/^\.athva\/contexts\/?/, "");
    return `${projectRoot}/.athva/contexts/${normalized.replace(/^\/+/, "")}`;
  }

  private clip(value: string, limit: number): string {
    return value.length > limit ? `${value.slice(0, limit)}…` : value;
  }

  private escapeHtml(value: string): string {
    const div = document.createElement("div");
    div.textContent = value;
    return div.innerHTML;
  }
}
