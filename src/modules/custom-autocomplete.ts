import ace from "ace-builds";

type AceEditor = ace.Ace.Editor;
type AceCommandEvent = { editor: AceEditor; command?: { name?: string }; args?: unknown };
type AceMouseEvent = { domEvent?: MouseEvent };
type CompletionItem = {
  caption?: string;
  value?: string;
  snippet?: string;
  meta?: string;
  score?: number;
};

type CompletionProviderInstance = {
  active: boolean;
  completions?: { filtered: CompletionItem[]; filterText: string };
  provideCompletions: (
    editor: AceEditor,
    options: Record<string, unknown>,
    callback: (err: unknown, completions: { filtered: CompletionItem[]; filterText: string }, finished: boolean) => void
  ) => void;
  insertMatch: (editor: AceEditor, item: CompletionItem, options?: Record<string, unknown>) => boolean;
  detach: () => void;
};

type CompletionProviderCtor = new (initialPosition: { prefix: string; pos: ace.Ace.Point }) => CompletionProviderInstance;

const autocomplete = ace.require("ace/autocomplete");
const util = ace.require("ace/autocomplete/util");
const languageTools = ace.require("ace/ext/language_tools");
const CompletionProvider = autocomplete.CompletionProvider as CompletionProviderCtor;

const DEFAULT_COMPLETERS = [
  languageTools.snippetCompleter,
  languageTools.textCompleter,
  languageTools.keyWordCompleter,
].filter(Boolean) as ace.Ace.Completer[];

function getCompletionPrefix(editor: AceEditor): string {
  return (util.getCompletionPrefix(editor) || "") as string;
}

function getInsertLabel(item: CompletionItem): string {
  return String(item.caption || item.value || item.snippet || "").trim();
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export class CustomAutocomplete {
  private editor: AceEditor;
  private popupEl: HTMLDivElement;
  private listEl: HTMLDivElement;
  private metaEl: HTMLDivElement;
  private previewEl: HTMLDivElement;
  private provider: CompletionProviderInstance | null = null;
  private items: CompletionItem[] = [];
  private selectedIndex = 0;
  private requestId = 0;
  private open = false;
  private currentPrefix = "";

  constructor(editor: AceEditor) {
    this.editor = editor;
    this.ensureCompleters();

    this.popupEl = document.createElement("div");
    this.popupEl.className = "editor-autocomplete hidden";

    const headerEl = document.createElement("div");
    headerEl.className = "editor-autocomplete-header";
    headerEl.innerHTML = `
      <span class="editor-autocomplete-title">Suggestions</span>
      <span class="editor-autocomplete-hint">Tab to apply</span>
    `;

    this.listEl = document.createElement("div");
    this.listEl.className = "editor-autocomplete-list";

    this.metaEl = document.createElement("div");
    this.metaEl.className = "editor-autocomplete-meta";

    this.previewEl = document.createElement("div");
    this.previewEl.className = "editor-autocomplete-preview hidden";

    this.popupEl.appendChild(headerEl);
    this.popupEl.appendChild(this.listEl);
    this.popupEl.appendChild(this.metaEl);

    const container = this.editor.container as HTMLElement;
    container.appendChild(this.popupEl);
    container.appendChild(this.previewEl);

    this.editor.commands.on("afterExec", this.onAfterExec);
    this.editor.on("changeSelection", this.onSelectionChange);
    this.editor.on("blur", this.onBlur);
    this.editor.on("mousedown", this.onMouseDown);
    this.editor.session.on("changeScrollTop", this.onViewportChange);
    this.editor.session.on("changeScrollLeft", this.onViewportChange);
    this.editor.renderer.on("resize", this.onViewportChange);

    container.addEventListener("keydown", this.onKeyDown, true);
  }

  hasOpenPopup(): boolean {
    return this.open;
  }

  trigger() {
    this.update({ manual: true });
  }

  addCompleter(completer: ace.Ace.Completer) {
    this.ensureCompleters();
    if (!this.editor.completers.includes(completer)) {
      this.editor.completers.push(completer);
    }
  }

  acceptSelected(): boolean {
    if (!this.open || !this.provider) return false;
    const item = this.items[this.selectedIndex];
    if (!item) return false;
    const accepted = this.provider.insertMatch(this.editor, item);
    this.hide();
    return accepted;
  }

  moveSelection(delta: number): boolean {
    if (!this.open || this.items.length === 0) return false;
    const nextIndex = (this.selectedIndex + delta + this.items.length) % this.items.length;
    if (nextIndex === this.selectedIndex) return false;
    this.selectedIndex = nextIndex;
    this.render();
    this.reposition();
    return true;
  }

  close() {
    this.hide();
  }

  private ensureCompleters() {
    if (!this.editor.completers || !this.editor.completers.length) {
      this.editor.completers = [...DEFAULT_COMPLETERS];
    }
  }

  private onAfterExec = (event: AceCommandEvent & { args?: unknown }) => {
    if (event.editor !== this.editor) return;
    const command = event.command?.name || "";
    if (command === "insertstring") {
      this.update({
        manual: false,
        previousChar: Array.isArray(event.args) ? undefined : typeof event.args === "string" ? event.args : undefined,
      });
      return;
    }
    if (command === "backspace" || command === "del") {
      this.update({ manual: false });
      return;
    }
    if (command === "paste") {
      this.update({ manual: false });
    }
  };

  private onSelectionChange = () => {
    if (this.editor.getSelectedText()) {
      this.hide();
    }
  };

  private onBlur = () => {
    window.setTimeout(() => {
      const focused = document.activeElement;
      if (focused && this.popupEl.contains(focused)) return;
      this.hide();
    }, 0);
  };

  private onMouseDown = (event: AceMouseEvent) => {
    const target = (event.domEvent?.target ?? null) as Node | null;
    if (target && this.popupEl.contains(target)) return;
    this.hide();
  };

  private onViewportChange = () => {
    if (this.open) {
      this.reposition();
    }
  };

  private onKeyDown = (event: KeyboardEvent) => {
    if (!this.open) return;

    if (event.key === "Tab" && !event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      this.acceptSelected();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      event.stopPropagation();
      this.moveSelection(1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      this.moveSelection(-1);
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      event.stopPropagation();
      this.acceptSelected();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.hide();
    }
  };

  private update(options: { manual: boolean; previousChar?: string }) {
    if (this.editor.getReadOnly() || this.editor.getSelectedText()) {
      this.hide();
      return;
    }

    this.ensureCompleters();

    const prefix = getCompletionPrefix(this.editor);
    const shouldTrigger = Boolean(options.manual || util.triggerAutocomplete(this.editor, options.previousChar));
    if (!options.manual && !prefix && !shouldTrigger) {
      this.hide();
      return;
    }

    const pos = this.editor.getCursorPosition();
    this.provider?.detach();
    const provider = new CompletionProvider({ prefix, pos });
    this.provider = provider;
    this.currentPrefix = prefix;
    const requestId = ++this.requestId;

    provider.provideCompletions(
      this.editor,
      { exactMatch: false, ignoreCaption: false },
      (err, completions, finished) => {
        if (requestId !== this.requestId || !this.provider || this.provider !== provider || !provider.active) {
          return;
        }
        if (err) {
          this.hide();
          return;
        }

        const latestPrefix = getCompletionPrefix(this.editor);
        const filtered = completions.filtered || [];
        const nextItems = filtered.filter((item) => !!getInsertLabel(item));

        if (finished && this.shouldHide(nextItems, latestPrefix)) {
          this.hide();
          return;
        }

        if (!nextItems.length) return;

        this.currentPrefix = latestPrefix;
        this.items = nextItems.slice(0, 8);
        this.selectedIndex = this.getPreferredIndex();
        this.open = true;
        this.render();
        this.reposition();
      }
    );
  }

  private shouldHide(items: CompletionItem[], prefix: string): boolean {
    if (!items.length) return true;
    if (items.length !== 1) return false;
    const onlyItem = items[0];
    return onlyItem.value === prefix && !onlyItem.snippet;
  }

  private getPreferredIndex(): number {
    if (!this.items.length) return 0;
    const exact = this.items.findIndex((item) => getInsertLabel(item) === this.currentPrefix);
    if (exact > 0) return exact;
    return 0;
  }

  private render() {
    this.popupEl.classList.remove("hidden");
    this.popupEl.innerHTML = `
      <div class="editor-autocomplete-header">
        <span class="editor-autocomplete-title">Suggestions</span>
        <span class="editor-autocomplete-hint">${this.selectedIndex + 1}/${this.items.length}</span>
      </div>
    `;

    this.listEl = document.createElement("div");
    this.listEl.className = "editor-autocomplete-list";

    this.items.forEach((item, index) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = `editor-autocomplete-item${index === this.selectedIndex ? " active" : ""}`;
      row.innerHTML = `
        <span class="editor-autocomplete-item-main">
          <span class="editor-autocomplete-item-label">${escapeHtml(getInsertLabel(item))}</span>
          ${item.meta ? `<span class="editor-autocomplete-item-tag">${escapeHtml(String(item.meta))}</span>` : ""}
        </span>
      `;

      row.addEventListener("mouseenter", () => {
        if (this.selectedIndex === index) return;
        this.selectedIndex = index;
        this.render();
        this.reposition();
      });

      row.addEventListener("mousedown", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.selectedIndex = index;
        this.acceptSelected();
      });

      this.listEl.appendChild(row);
    });

    this.metaEl = document.createElement("div");
    this.metaEl.className = "editor-autocomplete-meta";
    const active = this.items[this.selectedIndex];
    const activeMeta = active?.meta ? String(active.meta) : active?.snippet ? "snippet" : "completion";
    this.metaEl.innerHTML = `
      <span>${escapeHtml(activeMeta)}</span>
      <span class="editor-autocomplete-meta-keys">↑↓ navigate · Enter apply · Esc close</span>
    `;

    this.popupEl.appendChild(this.listEl);
    this.popupEl.appendChild(this.metaEl);

    this.renderPreview();
  }

  private renderPreview() {
    const item = this.items[this.selectedIndex];
    if (!item || item.snippet) {
      this.previewEl.classList.add("hidden");
      this.previewEl.textContent = "";
      return;
    }

    const value = String(item.value ?? item.caption ?? "");
    const remainder = this.currentPrefix && value.startsWith(this.currentPrefix)
      ? value.slice(this.currentPrefix.length)
      : "";

    if (!remainder || remainder.includes("\n")) {
      this.previewEl.classList.add("hidden");
      this.previewEl.textContent = "";
      return;
    }

    this.previewEl.textContent = remainder;
    this.previewEl.classList.remove("hidden");
  }

  private reposition() {
    const pos = this.editor.getCursorPosition();
    const coords = this.editor.renderer.textToScreenCoordinates(pos.row, pos.column);
    const editorRect = (this.editor.container as HTMLElement).getBoundingClientRect();
    const left = coords.pageX - editorRect.left;
    const top = coords.pageY - editorRect.top;
    const lineHeight = this.editor.renderer.lineHeight;

    const popupWidth = 360;
    const popupHeight = Math.min(320, 56 + this.items.length * 42);
    const maxLeft = Math.max(12, editorRect.width - popupWidth - 12);
    const popupLeft = Math.max(12, Math.min(left + 8, maxLeft));
    const showAbove = top + lineHeight + popupHeight + 20 > editorRect.height;
    const popupTop = showAbove
      ? Math.max(12, top - popupHeight - 10)
      : Math.max(12, top + lineHeight + 8);

    this.popupEl.style.left = `${popupLeft}px`;
    this.popupEl.style.top = `${popupTop}px`;

    if (this.previewEl.classList.contains("hidden")) return;
    this.previewEl.style.left = `${left}px`;
    this.previewEl.style.top = `${top}px`;
    this.previewEl.style.height = `${lineHeight}px`;
    this.previewEl.style.fontSize = `${this.editor.getFontSize()}px`;
  }

  private hide() {
    this.requestId += 1;
    this.provider?.detach();
    this.provider = null;
    this.items = [];
    this.selectedIndex = 0;
    this.open = false;
    this.popupEl.classList.add("hidden");
    this.previewEl.classList.add("hidden");
    this.previewEl.textContent = "";
  }
}
