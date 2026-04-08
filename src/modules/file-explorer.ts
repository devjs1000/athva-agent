import { invoke } from "@tauri-apps/api/core";
import { getFolderIcon, getFileIcon } from "./file-icons";
import { ContextMenu, type ContextMenuTarget } from "./context-menu";

export interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

export type OnFileSelect = (path: string, name: string) => void;

export class FileExplorer {
  private container: HTMLElement;
  private onFileSelect: OnFileSelect;
  private contextMenu: ContextMenu;
  private rootPath: string = "";
  // Track loaded dir containers so we can refresh specific dirs
  private dirContainers: Map<string, { el: HTMLElement; depth: number }> = new Map();

  constructor(containerId: string, onFileSelect: OnFileSelect) {
    this.container = document.getElementById(containerId)!;
    this.onFileSelect = onFileSelect;

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
  }

  async loadRoot(rootPath: string) {
    this.rootPath = rootPath;
    this.container.innerHTML = "";
    this.dirContainers.clear();
    this.contextMenu.setProjectRoot(rootPath);
    this.dirContainers.set(rootPath, { el: this.container, depth: 0 });
    await this.renderDir(this.container, rootPath, 0);
  }

  setOnRename(cb: (oldPath: string, newPath: string) => void) {
    this.contextMenu.setOnRename(cb);
  }

  setActiveFile(path: string) {
    this.container.querySelectorAll(".tree-item").forEach((el) => {
      el.classList.toggle("active", (el as HTMLElement).dataset.path === path);
    });
  }

  async refreshDir(dirPath: string) {
    const entry = this.dirContainers.get(dirPath);
    if (entry) {
      entry.el.innerHTML = "";
      await this.renderDir(entry.el, dirPath, entry.depth);
    } else {
      // Refresh root as fallback
      await this.loadRoot(this.rootPath);
    }
  }

  private async renderDir(parent: HTMLElement, dirPath: string, depth: number) {
    let entries: FileEntry[];
    try {
      entries = await invoke<FileEntry[]>("read_dir", { path: dirPath });
    } catch {
      return;
    }

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
      parent.appendChild(item);

      // Context menu on right-click
      const menuTarget: ContextMenuTarget = {
        path: entry.path,
        name: entry.name,
        isDir: entry.is_dir,
        parentDir: dirPath,
      };
      item.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.contextMenu.show(e.clientX, e.clientY, menuTarget);
      });

      if (entry.is_dir) {
        const children = document.createElement("div");
        children.className = "tree-children";
        parent.appendChild(children);

        // Track this dir container for refresh
        this.dirContainers.set(entry.path, { el: children, depth: depth + 1 });

        let loaded = false;
        item.addEventListener("click", async () => {
          const isExpanded = children.classList.contains("expanded");
          const chevron = item.querySelector(".tree-chevron") as HTMLElement;

          if (isExpanded) {
            children.classList.remove("expanded");
            chevron.classList.remove("expanded");
            icon.innerHTML = getFolderIcon(entry.name, false);
          } else {
            if (!loaded) {
              await this.renderDir(children, entry.path, depth + 1);
              loaded = true;
            }
            children.classList.add("expanded");
            chevron.classList.add("expanded");
            icon.innerHTML = getFolderIcon(entry.name, true);
          }
        });
      } else {
        item.addEventListener("click", () => {
          this.onFileSelect(entry.path, entry.name);
          this.setActiveFile(entry.path);
        });
      }
    }
  }
}
