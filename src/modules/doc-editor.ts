/**
 * Simple document editor for .txt files.
 * Provides a clean, formatted text editing experience with word wrap and line numbers.
 */

export class DocumentEditor {
  private container: HTMLElement;
  private textarea: HTMLTextAreaElement;
  private lineNumbersEl: HTMLElement;
  private onSave: (content: string) => void;
  private onToggleEditor: (() => void) | null = null;
  private saveTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(
    container: HTMLElement,
    initialContent: string,
    onSave: (content: string) => void,
    onToggleEditor?: () => void
  ) {
    this.container = container;
    this.onSave = onSave;
    this.onToggleEditor = onToggleEditor || null;

    // Build the editor UI
    this.container.innerHTML = `
      <div class="doc-editor">
        <div class="doc-toolbar">
          <div class="doc-toolbar-left">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="13" x2="12" y2="17"/><line x1="9" y1="15" x2="15" y2="15"/>
            </svg>
            <span class="doc-title">Document</span>
          </div>
          <div class="doc-toolbar-right">
            <span class="doc-info">Auto-saves as you type</span>
            <button class="doc-toggle-btn" id="doc-toggle-editor" title="Switch to normal editor">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>
              </svg>
              Code
            </button>
          </div>
        </div>

        <div class="doc-editor-wrapper">
          <div class="doc-line-numbers"></div>
          <div class="doc-content-wrapper">
            <textarea class="doc-textarea" spellcheck="true"></textarea>
          </div>
        </div>
      </div>
    `;

    this.textarea = this.container.querySelector(".doc-textarea")!;
    this.lineNumbersEl = this.container.querySelector(".doc-line-numbers")!;

    this.textarea.value = initialContent;
    this.updateLineNumbers();

    // Save on change (debounced)
    this.textarea.addEventListener("input", () => this.onInput());
    this.textarea.addEventListener("scroll", () => this.syncScroll());

    // Toggle editor button
    const toggleBtn = this.container.querySelector("#doc-toggle-editor");
    if (toggleBtn && this.onToggleEditor) {
      toggleBtn.addEventListener("click", () => this.onToggleEditor?.());
    }

    // Initial focus
    this.textarea.focus();
  }

  private onInput() {
    this.updateLineNumbers();
    if (this.saveTimeout) clearTimeout(this.saveTimeout);
    this.saveTimeout = setTimeout(() => {
      this.onSave(this.textarea.value);
    }, 800);
  }

  private updateLineNumbers() {
    const lines = this.textarea.value.split("\n").length;
    const currentLines = this.lineNumbersEl.querySelectorAll(".doc-line-number").length;

    if (lines > currentLines) {
      for (let i = currentLines + 1; i <= lines; i++) {
        const line = document.createElement("div");
        line.className = "doc-line-number";
        line.textContent = String(i);
        this.lineNumbersEl.appendChild(line);
      }
    } else if (lines < currentLines) {
      for (let i = currentLines; i > lines; i--) {
        this.lineNumbersEl.removeChild(this.lineNumbersEl.lastChild!);
      }
    }
  }

  private syncScroll() {
    this.lineNumbersEl.scrollTop = this.textarea.scrollTop;
  }

  reload(content: string) {
    const scrollTop = this.textarea.scrollTop;
    const selStart = this.textarea.selectionStart;
    const selEnd = this.textarea.selectionEnd;

    this.textarea.value = content;
    this.updateLineNumbers();

    this.textarea.scrollTop = scrollTop;
    this.textarea.setSelectionRange(selStart, selEnd);
  }

  getValue(): string {
    return this.textarea.value;
  }
}
