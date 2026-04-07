// Snippets panel — browse and insert code snippets by language

import { SNIPPET_CATEGORIES, type Snippet, type SnippetCategory } from "./snippets-data";

export class SnippetsPanel {
  private panelEl: HTMLElement;
  private listEl: HTMLElement;
  private searchEl: HTMLInputElement;
  private activeCategory: string = "typescript";
  private insertCallback: ((text: string) => void) | null = null;

  constructor(panelId: string) {
    this.panelEl = document.getElementById(panelId)!;
    this.listEl = this.panelEl.querySelector(".snippets-list")!;
    this.searchEl = this.panelEl.querySelector(".snippets-search") as HTMLInputElement;

    // Category tabs
    const tabsEl = this.panelEl.querySelector(".snippets-tabs")!;
    tabsEl.innerHTML = SNIPPET_CATEGORIES.map(
      (c) =>
        `<button class="snippets-tab${c.id === this.activeCategory ? " active" : ""}" data-cat="${c.id}" title="${c.label}">
          <svg width="16" height="16" viewBox="0 0 16 16">${c.icon}</svg>
        </button>`
    ).join("");

    tabsEl.querySelectorAll(".snippets-tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        this.activeCategory = (btn as HTMLElement).dataset.cat!;
        tabsEl.querySelectorAll(".snippets-tab").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        this.render();
      });
    });

    // Search
    this.searchEl.addEventListener("input", () => this.render());

    // Close button
    this.panelEl.querySelector("#btn-close-snippets")?.addEventListener("click", () => this.hide());

    this.render();
  }

  /** Register callback to insert snippet text into editor */
  onInsert(cb: (text: string) => void) {
    this.insertCallback = cb;
  }

  show() {
    this.panelEl.classList.remove("hidden");
    this.searchEl.focus();
    this.render();
  }

  hide() {
    this.panelEl.classList.add("hidden");
  }

  toggle() {
    if (this.panelEl.classList.contains("hidden")) {
      this.show();
    } else {
      this.hide();
    }
  }

  isVisible(): boolean {
    return !this.panelEl.classList.contains("hidden");
  }

  private getCategory(): SnippetCategory | undefined {
    return SNIPPET_CATEGORIES.find((c) => c.id === this.activeCategory);
  }

  private render() {
    const cat = this.getCategory();
    if (!cat) { this.listEl.innerHTML = ""; return; }

    const query = this.searchEl.value.trim().toLowerCase();
    const filtered = query
      ? cat.snippets.filter(
          (s) =>
            s.label.toLowerCase().includes(query) ||
            s.prefix.toLowerCase().includes(query) ||
            s.description.toLowerCase().includes(query)
        )
      : cat.snippets;

    if (filtered.length === 0) {
      this.listEl.innerHTML = `<div class="snippets-empty">No snippets match "${this.escapeHtml(query)}"</div>`;
      return;
    }

    this.listEl.innerHTML = filtered
      .map(
        (s, i) =>
          `<div class="snippet-item" data-idx="${i}">
            <div class="snippet-item-header">
              <span class="snippet-prefix">${this.escapeHtml(s.prefix)}</span>
              <span class="snippet-label">${this.escapeHtml(s.label)}</span>
            </div>
            <div class="snippet-desc">${this.escapeHtml(s.description)}</div>
            <pre class="snippet-preview">${this.escapeHtml(this.cleanBody(s.body))}</pre>
          </div>`
      )
      .join("");

    this.listEl.querySelectorAll(".snippet-item").forEach((el, i) => {
      el.addEventListener("click", () => {
        this.insertSnippet(filtered[i]);
      });
    });
  }

  private insertSnippet(snippet: Snippet) {
    // Strip tabstop markers: ${N:text} → text, $N → ""
    const clean = snippet.body
      .replace(/\$\{(\d+):([^}]*)}/g, "$2")
      .replace(/\$\d+/g, "");
    if (this.insertCallback) {
      this.insertCallback(clean);
    }
  }

  private cleanBody(body: string): string {
    return body
      .replace(/\$\{(\d+):([^}]*)}/g, "$2")
      .replace(/\$\d+/g, "");
  }

  private escapeHtml(str: string): string {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }
}
