import { invoke } from "@tauri-apps/api/core";
import { getAthvaSpecialEntry, getAthvaSpecialEntryGuide, getFolderIcon, getFileIcon } from "./file-icons";
import { ContextMenu, type ContextMenuTarget, type GetExtensionContextMenuItems } from "./context-menu";

export interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

export type OnFileSelect = (path: string, name: string) => void;
export type OnDirectorySelect = (path: string, name: string) => void;

export class FileExplorer {
  private static readonly INFO_COLLAPSED_STORAGE_KEY = "athva.explorerInfoCollapsed";
  private container: HTMLElement;
  private onFileSelect: OnFileSelect;
  private onDirectorySelect: OnDirectorySelect | null;
  private contextMenu: ContextMenu;
  private infoContainer: HTMLElement | null;
  private infoCollapsed: boolean;
  private rootPath: string = "";
  // Track loaded dir containers so we can refresh specific dirs
  private dirContainers: Map<string, { el: HTMLElement; depth: number }> = new Map();
  // Invalidates in-flight renders when the whole tree is reloaded, so two
  // concurrent loadRoot calls can't interleave their appends
  private renderToken = 0;
  // Dedupe concurrent refreshes of the same directory
  private refreshing: Map<string, Promise<void>> = new Map();

  constructor(containerId: string, onFileSelect: OnFileSelect, onDirectorySelect?: OnDirectorySelect) {
    this.container = document.getElementById(containerId)!;
    this.onFileSelect = onFileSelect;
    this.onDirectorySelect = onDirectorySelect ?? null;
    this.infoContainer = document.getElementById("explorer-info");
    this.infoCollapsed = localStorage.getItem(FileExplorer.INFO_COLLAPSED_STORAGE_KEY) === "1";

    this.contextMenu = new ContextMenu(
      (dirPath) => this.refreshDir(dirPath),
      (path, name) => {
        this.onFileSelect(path, name);
        this.setActiveFile(path);
      }
    );

    this.container.addEventListener("contextmenu", (e) => {
      if (!this.rootPath) return;
      if ((e.target as HTMLElement).closest(".tree-item")) return;

      e.preventDefault();
      e.stopPropagation();

      const rootName = this.rootPath.split("/").filter(Boolean).pop() || this.rootPath;
      this.contextMenu.show(e.clientX, e.clientY, {
        path: this.rootPath,
        name: rootName,
        isDir: true,
        parentDir: this.rootPath,
      });
    });

    this.renderSpecialInfo();
  }

  async loadRoot(rootPath: string) {
    const token = ++this.renderToken;
    this.rootPath = rootPath;
    this.container.innerHTML = "";
    this.dirContainers.clear();
    this.refreshing.clear();
    this.contextMenu.setProjectRoot(rootPath);
    this.dirContainers.set(rootPath, { el: this.container, depth: 0 });
    await this.renderDir(this.container, rootPath, 0, token);
  }

  setOnRename(cb: (oldPath: string, newPath: string) => void) {
    this.contextMenu.setOnRename(cb);
  }

  setOnResetContexts(cb: () => Promise<void>) {
    this.contextMenu.setOnResetContexts(cb);
  }

  setOnInitContexts(cb: () => Promise<void>) {
    this.contextMenu.setOnInitContexts(cb);
  }

  setOnCompactContexts(cb: () => Promise<void>) {
    this.contextMenu.setOnCompactContexts(cb);
  }

  setExtensionContextMenuItems(getItems: GetExtensionContextMenuItems) {
    this.contextMenu.setExtensionContextMenuItems(getItems);
  }

  setActiveFile(path: string) {
    this.container.querySelectorAll(".tree-item").forEach((el) => {
      el.classList.toggle("active", (el as HTMLElement).dataset.path === path);
    });
  }

  async refreshDir(dirPath: string) {
    const inFlight = this.refreshing.get(dirPath);
    if (inFlight) return inFlight;

    const entry = this.dirContainers.get(dirPath);
    if (!entry) {
      // Refresh root as fallback
      await this.loadRoot(this.rootPath);
      return;
    }

    const run = (async () => {
      entry.el.innerHTML = "";
      await this.renderDir(entry.el, dirPath, entry.depth, this.renderToken);
    })().finally(() => {
      this.refreshing.delete(dirPath);
    });
    this.refreshing.set(dirPath, run);
    await run;
  }

  private async renderDir(parent: HTMLElement, dirPath: string, depth: number, token: number = this.renderToken) {
    let entries: FileEntry[];
    try {
      entries = await invoke<FileEntry[]>("read_dir", { path: dirPath });
    } catch {
      return;
    }
    // A newer loadRoot cleared the tree while we were reading — drop this render
    if (token !== this.renderToken) return;

    for (const entry of entries) {
      const item = document.createElement("div");
      item.className = "tree-item";
      item.dataset.path = entry.path;
      item.style.setProperty("--depth", String(depth));

      const icon = document.createElement("span");
      icon.className = "tree-item-icon";

      if (entry.is_dir) {
        const chevron = document.createElement("span");
        chevron.className = "tree-chevron";
        chevron.innerHTML = `<svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M6 3.5L10.5 8 6 12.5V3.5Z"/></svg>`;
        icon.innerHTML = getFolderIcon(entry.name, false);

        item.appendChild(chevron);
        item.appendChild(icon);
      } else {
        const spacer = document.createElement("span");
        spacer.className = "tree-chevron-spacer";
        item.appendChild(spacer);
        icon.innerHTML = getFileIcon(entry.name);
        item.appendChild(icon);
      }

      const name = document.createElement("span");
      name.className = "tree-item-name";
      name.textContent = entry.name;
      item.appendChild(name);

      const special = getAthvaSpecialEntry(entry.name, entry.is_dir);
      if (special) {
        item.classList.add("tree-item-special", `tree-item-special-${special.kind}`);
        item.style.setProperty("--special-accent", special.accent);
        const badge = document.createElement("span");
        badge.className = "tree-item-badge";
        badge.textContent = special.label;
        item.appendChild(badge);
      }

      parent.appendChild(item);

      // Context menu on right-click
      const menuTarget: ContextMenuTarget = {
        path: entry.path,
        name: entry.name,
        isDir: entry.is_dir,
        parentDir: dirPath,
      };
      item.addEventListener("mousedown", (e) => {
        if ((e as MouseEvent).button !== 2) return;
        e.preventDefault();
        window.getSelection()?.removeAllRanges();
      });
      item.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        window.getSelection()?.removeAllRanges();
        this.contextMenu.show(e.clientX, e.clientY, menuTarget);
      });

      if (entry.is_dir) {
        const children = document.createElement("div");
        children.className = "tree-children";
        parent.appendChild(children);

        // Track this dir container for refresh
        this.dirContainers.set(entry.path, { el: children, depth: depth + 1 });

        let loadPromise: Promise<void> | null = null;
        item.addEventListener("click", async () => {
          const isExpanded = children.classList.contains("expanded");
          const chevron = item.querySelector(".tree-chevron") as HTMLElement;

          if (isExpanded) {
            children.classList.remove("expanded");
            chevron.classList.remove("expanded");
            icon.innerHTML = getFolderIcon(entry.name, false);
          } else {
            // Reuse the in-flight load so rapid double-clicks can't start two
            // renders that interleave their appended items
            if (!loadPromise) {
              loadPromise = this.renderDir(children, entry.path, depth + 1, token);
            }
            await loadPromise;
            children.classList.add("expanded");
            chevron.classList.add("expanded");
            icon.innerHTML = getFolderIcon(entry.name, true);
          }
          this.onDirectorySelect?.(entry.path, entry.name);
        });
      } else {
        item.addEventListener("click", () => {
          this.onFileSelect(entry.path, entry.name);
          this.setActiveFile(entry.path);
        });
      }
    }
  }

  private renderSpecialInfo() {
    if (!this.infoContainer) return;

    this.infoContainer.innerHTML = "";
    this.infoContainer.classList.toggle("collapsed", this.infoCollapsed);

    const header = document.createElement("button");
    header.type = "button";
    header.className = "explorer-info-header";
    header.setAttribute("aria-expanded", String(!this.infoCollapsed));
    header.addEventListener("click", () => this.toggleSpecialInfo());

    const title = document.createElement("div");
    title.className = "explorer-info-title";
    title.textContent = "Info";
    header.appendChild(title);

    const chevron = document.createElement("span");
    chevron.className = "explorer-info-chevron";
    chevron.innerHTML = `<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M5.5 3.5L10 8l-4.5 4.5v-9Z"/></svg>`;
    header.appendChild(chevron);

    this.infoContainer.appendChild(header);

    const subtitle = document.createElement("p");
    subtitle.className = "explorer-info-subtitle";
    subtitle.textContent = "Special folders, names, and extensions highlighted in Explorer.";
    if (this.infoCollapsed) {
      subtitle.classList.add("hidden");
    }
    this.infoContainer.appendChild(subtitle);

    for (const section of getAthvaSpecialEntryGuide()) {
      const sectionEl = document.createElement("section");
      sectionEl.className = "explorer-info-section";
      if (this.infoCollapsed) {
        sectionEl.classList.add("hidden");
      }

      const heading = document.createElement("div");
      heading.className = "explorer-info-section-title";
      heading.textContent = section.title;
      sectionEl.appendChild(heading);

      for (const item of section.items) {
        const row = document.createElement("div");
        row.className = "explorer-info-item";
        row.style.setProperty("--special-accent", item.accent);

        const badge = document.createElement("span");
        badge.className = "explorer-info-badge";
        badge.textContent = item.label;

        const details = document.createElement("div");
        details.className = "explorer-info-copy";

        const pattern = document.createElement("code");
        pattern.className = "explorer-info-pattern";
        pattern.textContent = item.pattern;

        const useCase = document.createElement("p");
        useCase.className = "explorer-info-use";
        useCase.textContent = item.useCase;

        details.appendChild(pattern);
        details.appendChild(useCase);
        row.appendChild(badge);
        row.appendChild(details);
        sectionEl.appendChild(row);
      }

      this.infoContainer.appendChild(sectionEl);
    }
  }

  private toggleSpecialInfo() {
    this.infoCollapsed = !this.infoCollapsed;
    localStorage.setItem(FileExplorer.INFO_COLLAPSED_STORAGE_KEY, this.infoCollapsed ? "1" : "0");
    this.renderSpecialInfo();
  }
}
