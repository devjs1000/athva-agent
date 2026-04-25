export interface TodoItem {
  id: string;
  text: string;
  done: boolean;
  createdAt: string;   // ISO-8601
  completedAt: string | null;
}

function uid(): string {
  return crypto.randomUUID?.() ?? Math.random().toString(36).slice(2);
}

function fmt(iso: string): string {
  const d = new Date(iso);
  const date = d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const time = d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
  return `${date} at ${time}`;
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Parse file content — accepts JSON array or GitHub-flavoured markdown checkboxes. */
function parse(raw: string): TodoItem[] {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "[]") return [];

  // JSON array
  if (trimmed.startsWith("[")) {
    try {
      const data = JSON.parse(trimmed);
      if (Array.isArray(data)) return data as TodoItem[];
    } catch {
      /* fall through to markdown parser */
    }
  }

  // Markdown checkbox lines: `- [ ] text` or `- [x] text`
  const items: TodoItem[] = [];
  for (const line of trimmed.split("\n")) {
    const active = line.match(/^- \[ \] (.+)$/);
    if (active) {
      items.push({
        id: uid(),
        text: active[1].trim(),
        done: false,
        createdAt: new Date().toISOString(),
        completedAt: null,
      });
      continue;
    }
    const done = line.match(/^- \[x\] (.+?)(?:\s+<!--\s*completed:\s*(.+?)\s*-->)?$/i);
    if (done) {
      items.push({
        id: uid(),
        text: done[1].trim(),
        done: true,
        createdAt: new Date().toISOString(),
        completedAt: done[2] ? done[2].trim() : new Date().toISOString(),
      });
    }
  }
  return items;
}

type Filter = "all" | "active" | "done";

export class TodoPanel {
  private items: TodoItem[];
  private filter: Filter = "all";
  private readonly onSave: (content: string) => void;

  constructor(
    private readonly container: HTMLElement,
    initialContent: string,
    onSave: (content: string) => void
  ) {
    this.items = parse(initialContent);
    this.onSave = onSave;
    this.render();
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  reload(content: string) {
    this.items = parse(content);
    this.render();
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private serialize(): string {
    return JSON.stringify(this.items, null, 2);
  }

  private save() {
    this.onSave(this.serialize());
  }

  private addTask(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.items.unshift({
      id: uid(),
      text: trimmed,
      done: false,
      createdAt: new Date().toISOString(),
      completedAt: null,
    });
    this.save();
    this.render();
  }

  private toggleTask(id: string) {
    const item = this.items.find((t) => t.id === id);
    if (!item) return;
    item.done = !item.done;
    item.completedAt = item.done ? new Date().toISOString() : null;
    this.save();
    this.render();
  }

  private deleteTask(id: string) {
    this.items = this.items.filter((t) => t.id !== id);
    this.save();
    this.render();
  }

  private setFilter(f: Filter) {
    this.filter = f;
    this.render();
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  private render() {
    const visible =
      this.filter === "all"
        ? this.items
        : this.filter === "active"
        ? this.items.filter((t) => !t.done)
        : this.items.filter((t) => t.done);

    const pending = this.items.filter((t) => !t.done).length;
    const total = this.items.length;

    this.container.innerHTML = `
      <div class="todo-panel">

        <div class="todo-header">
          <div class="todo-header-left">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="5" width="6" height="6" rx="1"/><path d="m3 17 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/>
            </svg>
            <h2 class="todo-title">TODO</h2>
          </div>
          <span class="todo-stats">${pending} pending · ${total} total</span>
        </div>

        <div class="todo-input-row">
          <input class="todo-input" id="todo-new-input" type="text"
            placeholder="New task… press Enter to add" autocomplete="off" />
          <button class="todo-add-btn" id="todo-add-btn">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
              <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
            Add
          </button>
        </div>

        <div class="todo-filters">
          ${(["all", "active", "done"] as Filter[])
            .map(
              (f) =>
                `<button class="todo-filter-btn${this.filter === f ? " active" : ""}"
                  data-filter="${f}">${f.charAt(0).toUpperCase() + f.slice(1)}</button>`
            )
            .join("")}
        </div>

        <div class="todo-list">
          ${
            visible.length === 0
              ? `<div class="todo-empty">
                  <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" style="opacity:.3;margin-bottom:8px">
                    <path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>
                  </svg>
                  <div>${
                    this.filter === "active"
                      ? "No pending tasks"
                      : this.filter === "done"
                      ? "Nothing completed yet"
                      : "No tasks yet — add one above"
                  }</div>
                </div>`
              : visible
                  .map(
                    (item) => `
                  <div class="todo-item${item.done ? " done" : ""}" data-id="${item.id}">
                    <label class="todo-check-wrap">
                      <input type="checkbox" class="todo-checkbox" data-id="${item.id}"${item.done ? " checked" : ""} />
                      <span class="todo-checkmark"></span>
                    </label>
                    <div class="todo-item-body">
                      <span class="todo-item-text">${escHtml(item.text)}</span>
                      <div class="todo-item-meta">
                        ${
                          item.done && item.completedAt
                            ? `<span class="todo-completed-at">
                                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>
                                Completed ${fmt(item.completedAt)}
                              </span>`
                            : ""
                        }
                        <span class="todo-created-at">Created ${fmt(item.createdAt)}</span>
                      </div>
                    </div>
                    <button class="todo-delete-btn" data-id="${item.id}" title="Delete task">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                        <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                      </svg>
                    </button>
                  </div>`
                  )
                  .join("")
          }
        </div>
      </div>`;

    this.bindEvents();
  }

  private bindEvents() {
    const input = this.container.querySelector<HTMLInputElement>("#todo-new-input");

    input?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        this.addTask(input.value);
        input.value = "";
      }
    });

    this.container
      .querySelector("#todo-add-btn")
      ?.addEventListener("click", () => {
        if (input) {
          this.addTask(input.value);
          input.value = "";
          input.focus();
        }
      });

    this.container.querySelectorAll<HTMLElement>(".todo-filter-btn").forEach((btn) => {
      btn.addEventListener("click", () =>
        this.setFilter(btn.dataset.filter as Filter)
      );
    });

    this.container.querySelectorAll<HTMLInputElement>(".todo-checkbox").forEach((cb) => {
      cb.addEventListener("change", () => this.toggleTask(cb.dataset.id!));
    });

    this.container.querySelectorAll<HTMLElement>(".todo-delete-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.deleteTask(btn.dataset.id!);
      });
    });
  }
}
