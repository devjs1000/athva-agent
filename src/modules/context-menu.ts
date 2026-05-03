import { invoke } from "@tauri-apps/api/core";
import { showInputDialog, showConfirmDialog } from "./dialogs";

export interface ContextMenuTarget {
  path: string;
  name: string;
  isDir: boolean;
  parentDir: string;
}

export type OnRefresh = (dirPath: string) => void;
export type OnOpenFile = (path: string, name: string) => void;
export type OnResetContexts = () => Promise<void>;

interface MenuItem {
  label: string;
  action?: () => void;
  separator?: boolean;
  submenu?: MenuItem[];
}

export class ContextMenu {
  private el: HTMLElement;
  private onRefresh: OnRefresh;
  private onOpenFile: OnOpenFile;
  private onResetContexts: OnResetContexts | null = null;
  private onRenameCallback: ((oldPath: string, newPath: string) => void) | null = null;
  private projectRoot: string = "";

  constructor(onRefresh: OnRefresh, onOpenFile: OnOpenFile) {
    this.onRefresh = onRefresh;
    this.onOpenFile = onOpenFile;

    this.el = document.createElement("div");
    this.el.className = "context-menu hidden";
    document.body.appendChild(this.el);

    document.addEventListener("click", () => this.close());
    document.addEventListener("contextmenu", (e) => {
      if (!this.el.contains(e.target as Node)) {
        this.close();
      }
    });
  }

  setProjectRoot(root: string) {
    this.projectRoot = root;
  }

  setOnRename(cb: (oldPath: string, newPath: string) => void) {
    this.onRenameCallback = cb;
  }

  setOnResetContexts(cb: OnResetContexts) {
    this.onResetContexts = cb;
  }

  show(x: number, y: number, target: ContextMenuTarget) {
    const items = this.buildMenu(target);
    this.renderMenu(items);

    this.el.classList.remove("hidden");
    this.el.style.left = `${x}px`;
    this.el.style.top = `${y}px`;

    requestAnimationFrame(() => {
      const rect = this.el.getBoundingClientRect();
      if (rect.right > window.innerWidth) {
        this.el.style.left = `${window.innerWidth - rect.width - 4}px`;
      }
      if (rect.bottom > window.innerHeight) {
        this.el.style.top = `${window.innerHeight - rect.height - 4}px`;
      }
    });
  }

  close() {
    this.el.classList.add("hidden");
  }

  private buildMenu(target: ContextMenuTarget): MenuItem[] {
    const dir = target.isDir ? target.path : target.parentDir;
    const isProjectRoot = target.path === this.projectRoot;
    const isContextsRoot = target.isDir && /\/\.athva\/contexts$/.test(target.path);

    const items: MenuItem[] = [
      {
        label: "New File",
        action: () => this.promptNewFile(dir),
      },
      {
        label: "New Folder",
        action: () => this.promptNewFolder(dir),
      },
    ];

    if (isContextsRoot && this.onResetContexts) {
      items.push(
        { separator: true, label: "" },
        {
          label: "Reset Contexts",
          action: () => this.confirmResetContexts(target),
        },
      );
    }

    if (!isProjectRoot) {
      items.push(
        { separator: true, label: "" },
        {
          label: "Rename",
          action: () => this.promptRename(target),
        },
        {
          label: "Delete",
          action: () => this.confirmDelete(target),
        }
      );
    }

    items.push(
      { separator: true, label: "" },
      {
        label: "Copy Path",
        submenu: [
          ...(!isProjectRoot
            ? [{
                label: "Relative Path",
                action: () => this.copyRelativePath(target.path),
              }]
            : []),
          {
            label: "Absolute Path",
            action: () => this.copyToClipboard(target.path),
          },
        ],
      },
      {
        label: "Copy Name",
        action: () => this.copyToClipboard(target.name),
      },
      { separator: true, label: "" },
      {
        label: "Reveal in Finder",
        action: () => this.revealInExplorer(target.path),
      },
    );

    return items;
  }

  private renderMenu(items: MenuItem[]) {
    this.el.innerHTML = "";
    for (const item of items) {
      if (item.separator) {
        const sep = document.createElement("div");
        sep.className = "context-menu-separator";
        this.el.appendChild(sep);
        continue;
      }

      const row = document.createElement("div");
      row.className = "context-menu-item";

      const label = document.createElement("span");
      label.textContent = item.label;
      row.appendChild(label);

      if (item.submenu) {
        const arrow = document.createElement("span");
        arrow.className = "context-menu-arrow";
        arrow.textContent = "\u25B6";
        row.appendChild(arrow);

        const sub = document.createElement("div");
        sub.className = "context-submenu hidden";
        for (const subItem of item.submenu) {
          const subRow = document.createElement("div");
          subRow.className = "context-menu-item";
          subRow.textContent = subItem.label;
          subRow.addEventListener("click", (e) => {
            e.stopPropagation();
            this.close();
            subItem.action?.();
          });
          sub.appendChild(subRow);
        }

        row.addEventListener("mouseenter", () => {
          const rect = row.getBoundingClientRect();
          const menuRect = this.el.getBoundingClientRect();
          sub.style.left = "0";
          sub.style.top = "0";
          sub.classList.remove("hidden");
          const subRect = sub.getBoundingClientRect();
          // Horizontal: prefer right, flip left if overflow
          const rightSpace = window.innerWidth - rect.right;
          sub.style.left = rightSpace >= subRect.width
            ? `${rect.width}px`
            : `-${subRect.width}px`;
          // Vertical: align top with row, flip up if overflow bottom
          const topAligned = rect.top - menuRect.top;
          const wouldOverflowBottom = rect.top + subRect.height > window.innerHeight - 8;
          sub.style.top = wouldOverflowBottom
            ? `${rect.bottom - menuRect.top - subRect.height}px`
            : `${topAligned}px`;
        });
        row.addEventListener("mouseleave", (e) => {
          const related = e.relatedTarget as HTMLElement;
          if (!sub.contains(related)) {
            sub.classList.add("hidden");
          }
        });
        sub.addEventListener("mouseleave", () => {
          sub.classList.add("hidden");
        });

        this.el.appendChild(row);
        this.el.appendChild(sub);
      } else {
        row.addEventListener("click", (e) => {
          e.stopPropagation();
          this.close();
          item.action?.();
        });
        this.el.appendChild(row);
      }
    }
  }

  // ── Actions ──

  private async promptNewFile(dir: string) {
    const name = await showInputDialog("New File", "Enter file name", "");
    if (!name) return;
    const fullPath = `${dir}/${name}`;
    try {
      await invoke("create_file", { path: fullPath });
      this.onRefresh(dir);
      this.onOpenFile(fullPath, name);
    } catch (e) {
      await showConfirmDialog("Error", `Failed to create file: ${e}`, "OK");
    }
  }

  private async promptNewFolder(dir: string) {
    const name = await showInputDialog("New Folder", "Enter folder name", "");
    if (!name) return;
    const fullPath = `${dir}/${name}`;
    try {
      await invoke("create_dir", { path: fullPath });
      this.onRefresh(dir);
    } catch (e) {
      await showConfirmDialog("Error", `Failed to create folder: ${e}`, "OK");
    }
  }

  private async promptRename(target: ContextMenuTarget) {
    const newName = await showInputDialog("Rename", `Rename "${target.name}" to:`, target.name);
    if (!newName || newName === target.name) return;
    const newPath = `${target.parentDir}/${newName}`;
    try {
      await invoke("rename_path", { oldPath: target.path, newPath });
      this.onRenameCallback?.(target.path, newPath);
      this.onRefresh(target.parentDir);
    } catch (e) {
      await showConfirmDialog("Error", `Failed to rename: ${e}`, "OK");
    }
  }

  private async confirmDelete(target: ContextMenuTarget) {
    const ok = await showConfirmDialog(
      "Delete",
      `Are you sure you want to delete "${target.name}"? This cannot be undone.`,
      "Delete"
    );
    if (!ok) return;
    try {
      await invoke("delete_path", { path: target.path });
      this.onRefresh(target.parentDir);
    } catch (e) {
      await showConfirmDialog("Error", `Failed to delete: ${e}`, "OK");
    }
  }

  private async confirmResetContexts(target: ContextMenuTarget) {
    if (!this.onResetContexts) return;
    const ok = await showConfirmDialog(
      "Reset Contexts",
      `Clear everything inside "${target.name}" and rebuild the default context files? This cannot be undone.`,
      "Reset",
      "Cancel",
    );
    if (!ok) return;
    try {
      await this.onResetContexts();
      this.onRefresh(target.path);
    } catch (e) {
      await showConfirmDialog("Error", `Failed to reset contexts: ${e}`, "OK");
    }
  }

  private copyRelativePath(fullPath: string) {
    if (this.projectRoot && fullPath === this.projectRoot) {
      this.copyToClipboard(".");
    } else if (this.projectRoot && fullPath.startsWith(this.projectRoot)) {
      let rel = fullPath.substring(this.projectRoot.length);
      if (rel.startsWith("/")) rel = rel.substring(1);
      this.copyToClipboard(rel);
    } else {
      this.copyToClipboard(fullPath);
    }
  }

  private copyToClipboard(text: string) {
    navigator.clipboard.writeText(text).catch(() => {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    });
  }

  private async revealInExplorer(path: string) {
    try {
      await invoke("reveal_in_explorer", { path });
    } catch (e) {
      console.error("Reveal failed:", e);
    }
  }
}
