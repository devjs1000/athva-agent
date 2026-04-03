import { invoke } from "@tauri-apps/api/core";

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
      icon.className = `tree-item-icon ${entry.is_dir ? "folder" : "file"}`;
      icon.textContent = entry.is_dir ? "\u25B6" : "\u25CB";

      const name = document.createElement("span");
      name.className = "tree-item-name";
      name.textContent = entry.name;

      item.appendChild(icon);
      item.appendChild(name);
      parent.appendChild(item);

      if (entry.is_dir) {
        const children = document.createElement("div");
        children.className = "tree-children";
        parent.appendChild(children);

        let loaded = false;
        item.addEventListener("click", async () => {
          const isExpanded = children.classList.contains("expanded");
          if (isExpanded) {
            children.classList.remove("expanded");
            icon.textContent = "\u25B6";
          } else {
            if (!loaded) {
              await this.renderDir(children, entry.path, depth + 1);
              loaded = true;
            }
            children.classList.add("expanded");
            icon.textContent = "\u25BC";
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
