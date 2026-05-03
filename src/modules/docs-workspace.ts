import { invoke } from "@tauri-apps/api/core";
import type { FileEntry } from "./file-explorer";

export interface DocsPage {
  path: string;
  name: string;
  title: string;
  relativePath: string;
  depth: number;
}

export class DocsWorkspace {
  private panel: HTMLElement;
  private titleEl: HTMLElement;
  private listEl: HTMLElement;
  private emptyEl: HTMLElement;
  private closeBtn: HTMLButtonElement | null;
  private rootPath = "";
  private pages: DocsPage[] = [];
  private activePath = "";
  private onOpenPage: (page: DocsPage) => void;

  constructor(
    panelId: string,
    titleId: string,
    listId: string,
    emptyId: string,
    onOpenPage: (page: DocsPage) => void
  ) {
    this.panel = document.getElementById(panelId)!;
    this.titleEl = document.getElementById(titleId)!;
    this.listEl = document.getElementById(listId)!;
    this.emptyEl = document.getElementById(emptyId)!;
    this.closeBtn = document.getElementById("btn-close-docs-sidebar") as HTMLButtonElement | null;
    this.onOpenPage = onOpenPage;

    this.closeBtn?.addEventListener("click", () => this.close());
  }

  async openRoot(rootPath: string): Promise<DocsPage[]> {
    this.rootPath = rootPath;
    this.panel.classList.remove("hidden");
    this.titleEl.textContent = this.labelForRoot(rootPath);
    await this.reload();
    return this.pages;
  }

  async reload(): Promise<void> {
    if (!this.rootPath) return;
    const pages = await this.collectPages(this.rootPath);
    this.pages = pages.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    this.render();
  }

  close() {
    this.rootPath = "";
    this.pages = [];
    this.activePath = "";
    this.listEl.innerHTML = "";
    this.panel.classList.add("hidden");
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

  setActivePage(path: string) {
    this.activePath = path;
    this.listEl.querySelectorAll<HTMLElement>(".docs-page-item").forEach((el) => {
      el.classList.toggle("active", el.dataset.path === path);
    });
  }

  resolvePageLink(fromPath: string, rawHref: string): DocsPage | null {
    const href = decodeURIComponent((rawHref || "").trim());
    if (!href || href.startsWith("#")) return null;
    if (/^(https?:|mailto:)/i.test(href)) return null;

    if (href.startsWith("wiki:")) {
      return this.findWikiPage(href.slice(5).trim());
    }

    const cleaned = href.replace(/[?#].*$/, "");
    const candidatePath = cleaned.startsWith("/")
      ? this.normalizePath(`${this.rootPath}/${cleaned.replace(/^\/+/, "")}`)
      : this.normalizePath(`${this.dirname(fromPath)}/${cleaned}`);

    return (
      this.pages.find((page) => page.path === candidatePath) ||
      this.pages.find((page) => page.path === `${candidatePath}.md`) ||
      this.pages.find((page) => page.path === `${candidatePath}.txt`) ||
      this.findWikiPage(cleaned)
    );
  }

  private async collectPages(dirPath: string): Promise<DocsPage[]> {
    let entries: FileEntry[];
    try {
      entries = await invoke<FileEntry[]>("read_dir", { path: dirPath });
    } catch {
      return [];
    }

    const pages: DocsPage[] = [];
    for (const entry of entries) {
      if (entry.is_dir) {
        pages.push(...await this.collectPages(entry.path));
        continue;
      }
      pages.push({
        path: entry.path,
        name: entry.name,
        title: this.pageTitle(entry.name),
        relativePath: this.relativePath(entry.path),
        depth: Math.max(0, entry.path.replace(`${this.rootPath}/`, "").split("/").length - 1),
      });
    }
    return pages;
  }

  private render() {
    this.listEl.innerHTML = "";
    this.emptyEl.classList.toggle("hidden", this.pages.length > 0);
    if (!this.pages.length) return;

    for (const page of this.pages) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "docs-page-item";
      button.dataset.path = page.path;
      button.style.setProperty("--docs-depth", String(page.depth));
      button.innerHTML = `
        <span class="docs-page-title">${this.escapeHtml(page.title)}</span>
        <span class="docs-page-path">${this.escapeHtml(page.relativePath)}</span>
      `;
      button.addEventListener("click", () => {
        this.activePath = page.path;
        this.setActivePage(page.path);
        this.onOpenPage(page);
      });
      this.listEl.appendChild(button);
    }

    if (this.activePath) this.setActivePage(this.activePath);
  }

  private labelForRoot(rootPath: string): string {
    return rootPath.split("/").filter(Boolean).pop() || "DOCS";
  }

  private relativePath(path: string): string {
    return path.replace(`${this.rootPath}/`, "");
  }

  private pageTitle(name: string): string {
    return name.replace(/\.[^.]+$/, "").replace(/[-_]/g, " ");
  }

  private dirname(path: string): string {
    const parts = path.split("/");
    parts.pop();
    return parts.join("/") || "/";
  }

  private normalizePath(path: string): string {
    const stack: string[] = [];
    for (const part of path.split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") {
        stack.pop();
        continue;
      }
      stack.push(part);
    }
    return `/${stack.join("/")}`;
  }

  private findWikiPage(target: string): DocsPage | null {
    const normalized = target.replace(/\.[^.]+$/, "").replace(/^\/+/, "").toLowerCase();
    return this.pages.find((page) => {
      const relative = page.relativePath.replace(/\.[^.]+$/, "").toLowerCase();
      const title = page.title.toLowerCase();
      const basename = page.name.replace(/\.[^.]+$/, "").toLowerCase();
      return relative === normalized || title === normalized || basename === normalized;
    }) ?? null;
  }

  private escapeHtml(value: string): string {
    const div = document.createElement("div");
    div.textContent = value;
    return div.innerHTML;
  }
}
