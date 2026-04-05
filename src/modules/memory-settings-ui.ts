import type { AgentMemory, MemoryEntry } from "./agent-memory";
import type { AppSettings } from "./settings";

export class MemorySettingsUI {
  private activeTab: "global" | "project" = "global";
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private containerEl: HTMLElement | null = null;

  constructor(private memory: AgentMemory, _getSettings: () => AppSettings, _saveSettings: () => Promise<void>) {}

  async refresh(): Promise<void> {
    this.containerEl = document.getElementById("memory-settings-container");
    if (!this.containerEl) return;
    this.render();
    await this.loadList();
    await this.updateStats();
  }

  private render(): void {
    if (!this.containerEl) return;
    this.containerEl.innerHTML = `
      <div class="memory-stats-bar" id="memory-stats-bar">Loading…</div>
      <div class="memory-tabs">
        <button class="memory-tab-btn${this.activeTab === "global" ? " active" : ""}" data-tab="global">Global</button>
        <button class="memory-tab-btn${this.activeTab === "project" ? " active" : ""}" data-tab="project">Project</button>
      </div>
      <div class="memory-search-row">
        <input class="memory-search-input" id="memory-search-input" type="text" placeholder="Search memories…" />
        <button class="memory-clear-btn" id="memory-clear-btn" title="Clear all in this tab">Clear All</button>
      </div>
      <div class="memory-list" id="memory-list"></div>
    `;

    this.containerEl.querySelectorAll(".memory-tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        this.activeTab = (btn as HTMLElement).dataset.tab as "global" | "project";
        this.render();
        void this.loadList();
        void this.updateStats();
      });
    });

    const searchEl = this.containerEl.querySelector<HTMLInputElement>("#memory-search-input")!;
    searchEl.addEventListener("input", () => {
      if (this.searchTimer) clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => {
        const q = searchEl.value.trim();
        if (q) {
          void this.loadSearchResults(q);
        } else {
          void this.loadList();
        }
      }, 400);
    });

    this.containerEl.querySelector("#memory-clear-btn")!.addEventListener("click", async () => {
      if (!confirm(`Clear all ${this.activeTab} memories?`)) return;
      await this.memory.clear(this.activeTab);
      await this.loadList();
      await this.updateStats();
    });
  }

  private async loadList(): Promise<void> {
    const entries = await this.memory.list(this.activeTab);
    this.renderEntries(entries);
  }

  private async loadSearchResults(query: string): Promise<void> {
    const entries = await this.memory.search(query, 20);
    // Filter to active tab
    const filtered = entries.filter((e) => e.memory_type === this.activeTab);
    this.renderEntries(filtered);
  }

  private renderEntries(entries: MemoryEntry[]): void {
    const listEl = this.containerEl?.querySelector<HTMLElement>("#memory-list");
    if (!listEl) return;

    if (entries.length === 0) {
      listEl.innerHTML = `<div class="memory-empty">No ${this.activeTab} memories yet.</div>`;
      return;
    }

    listEl.innerHTML = entries
      .map((e) => {
        const date = new Date(e.created_at * 1000).toLocaleDateString();
        const preview = e.content.length > 120 ? e.content.slice(0, 120) + "…" : e.content;
        return `<div class="memory-entry" data-id="${e.id}">
          <span class="memory-entry-content" title="${this.escHtml(e.content)}">${this.escHtml(preview)}</span>
          <span class="memory-entry-date">${date}</span>
          <button class="memory-entry-delete" title="Delete">×</button>
        </div>`;
      })
      .join("");

    listEl.querySelectorAll(".memory-entry-delete").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const entry = (btn as HTMLElement).closest(".memory-entry") as HTMLElement;
        const id = Number(entry.dataset.id);
        await this.memory.delete(id);
        entry.remove();
        await this.updateStats();
      });
    });
  }

  private async updateStats(): Promise<void> {
    const statsEl = this.containerEl?.querySelector<HTMLElement>("#memory-stats-bar");
    if (!statsEl) return;
    try {
      const stats = await this.memory.stats();
      statsEl.textContent = `${stats.global_count} global · ${stats.project_count} project`;
    } catch {
      statsEl.textContent = "";
    }
  }

  private escHtml(str: string): string {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }
}
