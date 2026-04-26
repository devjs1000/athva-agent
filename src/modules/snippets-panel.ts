// Snippets panel — browse, create, and insert snippets by language

import { SNIPPET_CATEGORIES, type SnippetCategory } from "./snippets-data";
import { SnippetStore, type SnippetEntry } from "./snippet-store";

export class SnippetsPanel {
  private panelEl: HTMLElement;
  private listEl: HTMLElement;
  private searchEl: HTMLInputElement;
  private tabsEl: HTMLElement;
  private composerEl: HTMLElement;
  private composerCategoryEl: HTMLSelectElement;
  private composerScopeEl: HTMLSelectElement;
  private composerPrefixEl: HTMLInputElement;
  private composerLabelEl: HTMLInputElement;
  private composerDescriptionEl: HTMLInputElement;
  private composerBodyEl: HTMLTextAreaElement;
  private composerErrorEl: HTMLElement;
  private activeCategory = "typescript";
  private insertCallback: ((body: string) => void) | null = null;
  private readonly store = new SnippetStore();
  private projectPath = "";
  private loaded = false;

  constructor(panelId: string) {
    this.panelEl = document.getElementById(panelId)!;
    this.listEl = this.panelEl.querySelector(".snippets-list")!;
    this.searchEl = this.panelEl.querySelector(".snippets-search") as HTMLInputElement;
    this.tabsEl = this.panelEl.querySelector(".snippets-tabs")!;
    this.composerEl = this.panelEl.querySelector(".snippets-compose") as HTMLElement;
    this.composerCategoryEl = this.panelEl.querySelector(".snippets-compose-category") as HTMLSelectElement;
    this.composerScopeEl = this.panelEl.querySelector(".snippets-compose-scope") as HTMLSelectElement;
    this.composerPrefixEl = this.panelEl.querySelector(".snippets-compose-prefix") as HTMLInputElement;
    this.composerLabelEl = this.panelEl.querySelector(".snippets-compose-label") as HTMLInputElement;
    this.composerDescriptionEl = this.panelEl.querySelector(".snippets-compose-description") as HTMLInputElement;
    this.composerBodyEl = this.panelEl.querySelector(".snippets-compose-body") as HTMLTextAreaElement;
    this.composerErrorEl = this.panelEl.querySelector(".snippets-compose-error") as HTMLElement;

    this.renderTabs();
    this.composerCategoryEl.innerHTML = SNIPPET_CATEGORIES
      .map((category) => `<option value="${category.id}">${this.escapeHtml(category.label)}</option>`)
      .join("");
    this.composerCategoryEl.value = this.activeCategory;

    this.searchEl.addEventListener("input", () => this.render());
    this.panelEl.querySelector("#btn-close-snippets")?.addEventListener("click", () => this.hide());
    this.panelEl.querySelector("#btn-add-snippet")?.addEventListener("click", () => this.openComposer());
    this.panelEl.querySelector("#btn-cancel-snippet")?.addEventListener("click", () => this.closeComposer());
    this.panelEl.querySelector("#btn-save-snippet")?.addEventListener("click", () => void this.saveSnippet());

    this.updateScopeOptions();
    this.render();
    void this.ensureLoaded();
  }

  onInsert(cb: (body: string) => void) {
    this.insertCallback = cb;
  }

  async setProjectPath(projectPath: string) {
    this.projectPath = projectPath;
    await this.store.setProjectPath(projectPath);
    this.updateScopeOptions();
    this.render();
  }

  getCompleter() {
    return this.store.getCustomCompleter();
  }

  show() {
    this.panelEl.classList.remove("hidden");
    document.getElementById("btn-toggle-snippets")?.classList.add("active");
    this.searchEl.focus();
    void this.ensureLoaded().then(() => this.render());
  }

  hide() {
    this.panelEl.classList.add("hidden");
    document.getElementById("btn-toggle-snippets")?.classList.remove("active");
    this.closeComposer();
  }

  toggle() {
    if (this.panelEl.classList.contains("hidden")) this.show();
    else this.hide();
  }

  isVisible(): boolean {
    return !this.panelEl.classList.contains("hidden");
  }

  private async ensureLoaded() {
    if (this.loaded) return;
    await this.store.init();
    if (this.projectPath) {
      await this.store.setProjectPath(this.projectPath);
    }
    this.loaded = true;
    this.render();
  }

  private renderTabs() {
    this.tabsEl.innerHTML = SNIPPET_CATEGORIES.map(
      (category) =>
        `<button class="snippets-tab${category.id === this.activeCategory ? " active" : ""}" data-cat="${category.id}" title="${category.label}">
          <svg width="16" height="16" viewBox="0 0 16 16">${category.icon}</svg>
        </button>`
    ).join("");

    this.tabsEl.querySelectorAll(".snippets-tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        this.activeCategory = (btn as HTMLElement).dataset.cat!;
        this.tabsEl.querySelectorAll(".snippets-tab").forEach((el) => el.classList.remove("active"));
        btn.classList.add("active");
        this.composerCategoryEl.value = this.activeCategory;
        this.render();
      });
    });
  }

  private render() {
    const category = this.getCategory();
    if (!category) {
      this.listEl.innerHTML = "";
      return;
    }

    const query = this.searchEl.value.trim().toLowerCase();
    const snippets = this.store.getSnippets(category.id);
    const filtered = query
      ? snippets.filter(
          (snippet) =>
            snippet.label.toLowerCase().includes(query) ||
            snippet.prefix.toLowerCase().includes(query) ||
            snippet.description.toLowerCase().includes(query)
        )
      : snippets;

    if (!filtered.length) {
      this.listEl.innerHTML = `<div class="snippets-empty">No snippets match "${this.escapeHtml(query)}"</div>`;
      return;
    }

    this.listEl.innerHTML = filtered
      .map(
        (snippet, index) => `
          <div class="snippet-item" data-idx="${index}">
            <div class="snippet-item-header">
              <span class="snippet-prefix">${this.escapeHtml(snippet.prefix)}</span>
              <span class="snippet-label">${this.escapeHtml(snippet.label)}</span>
              ${snippet.source === "builtin" ? "" : `<span class="snippet-scope">${this.escapeHtml(snippet.source)}</span>`}
            </div>
            <div class="snippet-desc">${this.escapeHtml(snippet.description || "Custom snippet")}</div>
            <pre class="snippet-preview">${this.escapeHtml(this.previewBody(snippet.body))}</pre>
          </div>
        `
      )
      .join("");

    this.listEl.querySelectorAll(".snippet-item").forEach((el, index) => {
      el.addEventListener("click", () => this.insertSnippet(filtered[index]));
    });
  }

  private getCategory(): SnippetCategory | undefined {
    return SNIPPET_CATEGORIES.find((category) => category.id === this.activeCategory);
  }

  private insertSnippet(snippet: SnippetEntry) {
    this.insertCallback?.(snippet.body);
  }

  private previewBody(body: string): string {
    return body
      .replace(/\$\{(\d+):([^}]*)}/g, "$2")
      .replace(/\$(\d+)/g, "");
  }

  private openComposer() {
    this.composerErrorEl.textContent = "";
    this.composerCategoryEl.value = this.activeCategory;
    this.composerScopeEl.value = this.projectPath ? "project" : "global";
    this.composerPrefixEl.value = "";
    this.composerLabelEl.value = "";
    this.composerDescriptionEl.value = "";
    this.composerBodyEl.value = "";
    this.updateScopeOptions();
    this.composerEl.classList.remove("hidden");
    this.composerPrefixEl.focus();
  }

  private closeComposer() {
    this.composerEl.classList.add("hidden");
    this.composerErrorEl.textContent = "";
  }

  private updateScopeOptions() {
    const projectOption = this.composerScopeEl.querySelector('option[value="project"]') as HTMLOptionElement | null;
    if (projectOption) {
      projectOption.disabled = !this.projectPath;
    }
    if (!this.projectPath && this.composerScopeEl.value === "project") {
      this.composerScopeEl.value = "global";
    }
  }

  private async saveSnippet() {
    const prefix = this.composerPrefixEl.value.trim();
    const label = this.composerLabelEl.value.trim();
    const body = this.composerBodyEl.value;
    if (!prefix || !label || !body.trim()) {
      this.composerErrorEl.textContent = "Prefix, label, and body are required.";
      return;
    }

    this.composerErrorEl.textContent = "";

    try {
      await this.store.createSnippet({
        category: this.composerCategoryEl.value,
        scope: this.composerScopeEl.value as "global" | "project",
        prefix,
        label,
        description: this.composerDescriptionEl.value.trim(),
        body,
      });
      this.activeCategory = this.composerCategoryEl.value;
      this.tabsEl.querySelectorAll(".snippets-tab").forEach((tab) => {
        tab.classList.toggle("active", (tab as HTMLElement).dataset.cat === this.activeCategory);
      });
      this.closeComposer();
      this.render();
    } catch (error) {
      this.composerErrorEl.textContent = error instanceof Error ? error.message : "Failed to save snippet.";
    }
  }

  private escapeHtml(value: string): string {
    const div = document.createElement("div");
    div.textContent = value;
    return div.innerHTML;
  }
}
