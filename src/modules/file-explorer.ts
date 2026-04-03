import { invoke } from "@tauri-apps/api/core";
import { getFolderIcon, getFileIcon } from "./file-icons";

export interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

export type OnFileSelect = (path: string, name: string) => void;

export class FileExplorer {
  private container: HTMLElement;
  private onFileSelect: OnFileSelect;

  constructor(containerId: string, onFileSelect: OnFileSelect) {
    this.container = document.getElementById(containerId)!;
    this.onFileSelect = onFileSelect;
  }

  async loadRoot(rootPath: string) {
    this.container.innerHTML = "";
    await this.renderDir(this.container, rootPath, 0);
  }

  setActiveFile(path: string) {
    this.container.querySelectorAll(".tree-item").forEach((el) => {
      el.classList.toggle("active", (el as HTMLElement).dataset.path === path);
    });
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
        // Chevron arrow for expand/collapse
        const chevron = document.createElement("span");
        chevron.className = "tree-chevron";
        chevron.innerHTML = `<svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M6 3.5L10.5 8 6 12.5V3.5Z"/></svg>`;

        // Folder icon
        icon.innerHTML = getFolderIcon(entry.name, false);

        item.appendChild(chevron);
        item.appendChild(icon);
      } else {
        // Spacer for alignment with folders (chevron width)
        const spacer = document.createElement("span");
        spacer.className = "tree-chevron-spacer";
        item.appendChild(spacer);

        // File icon
        icon.innerHTML = getFileIcon(entry.name);
        item.appendChild(icon);
      }

      const name = document.createElement("span");
      name.className = "tree-item-name";
      name.textContent = entry.name;

      item.appendChild(name);
      parent.appendChild(item);

      if (entry.is_dir) {
        const children = document.createElement("div");
        children.className = "tree-children";
        parent.appendChild(children);

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
