import { getProjects } from "../store/projects";
import type { Project } from "../store/projects";

type OnOpen = (path: string) => void;

function detectBadge(name: string, path: string): { cls: string; label: string } {
  const s = (name + path).toLowerCase();
  if (s.includes("react"))                                          return { cls: "badge-react", label: "REACT" };
  if (s.includes(".ts") || s.includes("typescript") || s.includes("-ts")) return { cls: "badge-ts",    label: "TS"    };
  if (s.includes("python") || s.includes(".py"))                   return { cls: "badge-py",    label: "PY"    };
  if (s.includes("rust") || s.includes(".rs"))                     return { cls: "badge-rs",    label: "RS"    };
  if (s.includes("golang") || s.includes("-go"))                   return { cls: "badge-go",    label: "GO"    };
  if (s.includes(".js") || s.includes("javascript") || s.includes("express") || s.includes("node")) return { cls: "badge-js", label: "JS" };
  return { cls: "badge-dir", label: "DIR" };
}

function relativeTime(ts: number): string {
  const d = Date.now() - ts * 1000;
  const m = Math.floor(d / 60000);
  if (m < 2)  return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days < 7) return `${days}d ago`;
  return `${Math.floor(days / 7)}w ago`;
}

function highlight(text: string, query: string): string {
  if (!query) return escapeHtml(text);
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return escapeHtml(text);
  return (
    escapeHtml(text.slice(0, idx)) +
    `<mark>${escapeHtml(text.slice(idx, idx + query.length))}</mark>` +
    escapeHtml(text.slice(idx + query.length))
  );
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export class ProjectSwitcher {
  private overlay: HTMLElement;
  private input: HTMLInputElement;
  private list: HTMLElement;
  private onOpen: OnOpen;

  private projects: Project[] = [];
  private filtered: Project[] = [];
  private selectedIdx = 0;
  private starred: Set<string>;

  constructor(onOpen: OnOpen) {
    this.overlay = document.getElementById("project-switcher-overlay")!;
    this.input   = document.getElementById("project-switcher-input") as HTMLInputElement;
    this.list    = document.getElementById("project-switcher-list")!;
    this.onOpen  = onOpen;
    this.starred = new Set(JSON.parse(localStorage.getItem("athva-starred") ?? "[]") as string[]);

    this.input.addEventListener("input",   () => this.render());
    this.input.addEventListener("keydown", (e) => this.onKey(e));
    this.overlay.addEventListener("click", (e) => {
      if (e.target === this.overlay) this.close();
    });
  }

  async open() {
    const store = await getProjects();
    // starred first, then by last_opened
    this.projects = [...store.projects].sort((a, b) => {
      const as = this.starred.has(a.path) ? 1 : 0;
      const bs = this.starred.has(b.path) ? 1 : 0;
      if (as !== bs) return bs - as;
      return b.last_opened - a.last_opened;
    });

    this.input.value = "";
    this.selectedIdx = 0;
    this.overlay.classList.remove("hidden");
    this.render();
    requestAnimationFrame(() => this.input.focus());
  }

  close() {
    this.overlay.classList.add("hidden");
    this.input.value = "";
    this.list.innerHTML = "";
  }

  isOpen(): boolean {
    return !this.overlay.classList.contains("hidden");
  }

  private render() {
    const q = this.input.value.trim().toLowerCase();

    this.filtered = q
      ? this.projects.filter(
          (p) => p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q)
        )
      : this.projects;

    if (this.selectedIdx >= this.filtered.length) this.selectedIdx = 0;

    if (this.filtered.length === 0) {
      this.list.innerHTML = `<div class="ps-empty">No matching projects</div>`;
      return;
    }

    this.list.innerHTML = this.filtered
      .map((p, i) => {
        const badge = detectBadge(p.name, p.path);
        const isStarred = this.starred.has(p.path);
        const active = i === this.selectedIdx ? " active" : "";
        return `
          <div class="ps-item${active}" data-idx="${i}" role="option" aria-selected="${i === this.selectedIdx}">
            <span class="ps-badge ${badge.cls}">${badge.label}</span>
            <div class="ps-info">
              <span class="ps-name">${highlight(p.name, q)}</span>
              <span class="ps-path">${highlight(p.path, q)}</span>
            </div>
            <span class="ps-time">${relativeTime(p.last_opened)}</span>
            ${isStarred ? `<svg class="ps-star" viewBox="0 0 16 16" fill="currentColor"><path d="M3.612 15.443c-.386.198-.824-.149-.746-.592l.83-4.73L.173 6.765c-.329-.314-.158-.888.283-.95l4.898-.696L7.538.792c.197-.39.73-.39.927 0l2.184 4.327 4.898.696c.441.062.612.636.282.95l-3.522 3.356.83 4.73c.078.443-.36.79-.746.592L8 13.187l-4.389 2.256z"/></svg>` : ""}
          </div>
        `;
      })
      .join("");

    this.list.querySelectorAll<HTMLElement>(".ps-item").forEach((el) => {
      el.addEventListener("click", () => {
        const idx = parseInt(el.dataset.idx ?? "0", 10);
        this.confirm(idx);
      });
      el.addEventListener("mouseenter", () => {
        this.selectedIdx = parseInt(el.dataset.idx ?? "0", 10);
        this.setActive();
      });
    });
  }

  private setActive() {
    this.list.querySelectorAll<HTMLElement>(".ps-item").forEach((el, i) => {
      el.classList.toggle("active", i === this.selectedIdx);
      el.setAttribute("aria-selected", String(i === this.selectedIdx));
    });
    this.scrollActive();
  }

  private scrollActive() {
    const el = this.list.querySelector<HTMLElement>(".ps-item.active");
    el?.scrollIntoView({ block: "nearest" });
  }

  private onKey(e: KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      this.selectedIdx = Math.min(this.selectedIdx + 1, this.filtered.length - 1);
      this.setActive();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      this.selectedIdx = Math.max(this.selectedIdx - 1, 0);
      this.setActive();
    } else if (e.key === "Enter") {
      e.preventDefault();
      this.confirm(this.selectedIdx);
    } else if (e.key === "Escape") {
      e.preventDefault();
      this.close();
    }
  }

  private confirm(idx: number) {
    const p = this.filtered[idx];
    if (!p) return;
    this.close();
    this.onOpen(p.path);
  }
}
