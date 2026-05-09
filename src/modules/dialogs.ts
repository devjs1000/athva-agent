// Custom dialog replacements for prompt(), confirm(), alert()
// since native dialogs are blocked in Tauri WebView

export interface CodeBookmarkDialogInput {
  title: string;
  description: string;
  tag: string;
}

export interface CodeBookmarkDialogResult {
  title: string;
  description: string;
  tag: string;
}

export function showInputDialog(title: string, placeholder: string, defaultValue: string = ""): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = document.getElementById("input-dialog")!;
    const titleEl = document.getElementById("input-dialog-title")!;
    const field = document.getElementById("input-dialog-field") as HTMLTextAreaElement;
    const okBtn = document.getElementById("input-dialog-ok")!;
    const cancelBtn = document.getElementById("input-dialog-cancel")!;

    titleEl.textContent = title;
    field.placeholder = placeholder;
    field.value = defaultValue;

    overlay.classList.remove("hidden");
    field.focus();
    field.select();

    const cleanup = () => {
      overlay.classList.add("hidden");
      field.removeEventListener("keydown", onKey);
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      overlay.removeEventListener("click", onOverlay);
    };

    const onOk = () => {
      const val = field.value.trim();
      cleanup();
      resolve(val || null);
    };

    const onCancel = () => {
      cleanup();
      resolve(null);
    };

    const onKey = (e: KeyboardEvent) => {
      // Cmd/Ctrl+Enter to submit (Enter alone inserts newline in textarea)
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onOk(); }
      if (e.key === "Escape") { e.preventDefault(); onCancel(); }
    };

    const onOverlay = (e: MouseEvent) => {
      if (e.target === overlay) onCancel();
    };

    field.addEventListener("keydown", onKey);
    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    overlay.addEventListener("click", onOverlay);
  });
}

export function showCodeBookmarkDialog(initial: CodeBookmarkDialogInput): Promise<CodeBookmarkDialogResult | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "dialog-overlay bookmark-dialog-overlay";
    overlay.innerHTML = `
      <div class="dialog dialog-sm bookmark-dialog-card" role="dialog" aria-label="Create bookmark">
        <h2>Add Bookmark</h2>
        <div class="dialog-field">
          <label>Title</label>
          <input class="bookmark-dialog-title" type="text" maxlength="120" spellcheck="false" />
        </div>
        <div class="dialog-field">
          <label>Description</label>
          <textarea class="bookmark-dialog-description input-dialog-field" rows="4" placeholder="What is important about this selection?"></textarea>
        </div>
        <div class="dialog-field">
          <label>Tag / Severity</label>
          <div class="bookmark-dialog-tags" role="listbox" aria-label="Bookmark tags">
            <button type="button" class="bookmark-dialog-tag" data-tag="critical">Critical</button>
            <button type="button" class="bookmark-dialog-tag" data-tag="high">High</button>
            <button type="button" class="bookmark-dialog-tag" data-tag="medium">Medium</button>
            <button type="button" class="bookmark-dialog-tag" data-tag="low">Low</button>
            <button type="button" class="bookmark-dialog-tag" data-tag="info">Info</button>
            <button type="button" class="bookmark-dialog-tag" data-tag="todo">Todo</button>
            <button type="button" class="bookmark-dialog-tag" data-tag="note">Note</button>
          </div>
          <input class="bookmark-dialog-tag-input" type="text" maxlength="32" spellcheck="false" placeholder="Custom tag (optional)" />
        </div>
        <div class="dialog-actions">
          <button class="btn-secondary bookmark-dialog-cancel" type="button">Cancel</button>
          <button class="btn-primary bookmark-dialog-save" type="button">Save Bookmark</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const titleEl = overlay.querySelector<HTMLInputElement>(".bookmark-dialog-title")!;
    const descriptionEl = overlay.querySelector<HTMLTextAreaElement>(".bookmark-dialog-description")!;
    const tagInputEl = overlay.querySelector<HTMLInputElement>(".bookmark-dialog-tag-input")!;
    const saveBtn = overlay.querySelector<HTMLButtonElement>(".bookmark-dialog-save")!;
    const cancelBtn = overlay.querySelector<HTMLButtonElement>(".bookmark-dialog-cancel")!;
    const tagButtons = Array.from(overlay.querySelectorAll<HTMLButtonElement>(".bookmark-dialog-tag"));

    let selectedTag = (initial.tag || "medium").trim().toLowerCase();

    const updateTagSelection = () => {
      tagButtons.forEach((button) => {
        button.classList.toggle("active", button.dataset.tag === selectedTag);
      });
    };

    titleEl.value = initial.title || "";
    descriptionEl.value = initial.description || "";
    tagInputEl.value = selectedTag;
    updateTagSelection();

    const cleanup = () => {
      document.removeEventListener("keydown", onKey);
      overlay.remove();
    };

    const onCancel = () => {
      cleanup();
      resolve(null);
    };

    const onSave = () => {
      const title = titleEl.value.trim();
      if (!title) {
        titleEl.focus();
        return;
      }
      const description = descriptionEl.value.trim();
      const tag = (tagInputEl.value.trim() || selectedTag || "note").toLowerCase();
      cleanup();
      resolve({ title, description, tag });
    };

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
        return;
      }
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        onSave();
      }
    };

    tagButtons.forEach((button) => {
      button.addEventListener("click", () => {
        selectedTag = button.dataset.tag || "note";
        tagInputEl.value = selectedTag;
        updateTagSelection();
      });
    });

    tagInputEl.addEventListener("input", () => {
      selectedTag = tagInputEl.value.trim().toLowerCase() || "note";
      updateTagSelection();
    });
    cancelBtn.addEventListener("click", onCancel);
    saveBtn.addEventListener("click", onSave);
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) onCancel();
    });
    document.addEventListener("keydown", onKey);

    titleEl.focus();
    titleEl.select();
  });
}

export function showConfirmDialog(
  title: string,
  message: string,
  confirmLabel: string = "Delete",
  cancelLabel: string = "Cancel"
): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.getElementById("confirm-dialog")!;
    const titleEl = document.getElementById("confirm-dialog-title")!;
    const msgEl = document.getElementById("confirm-dialog-message")!;
    const okBtn = document.getElementById("confirm-dialog-ok")!;
    const cancelBtn = document.getElementById("confirm-dialog-cancel")!;

    titleEl.textContent = title;
    msgEl.textContent = message;
    okBtn.textContent = confirmLabel;
    cancelBtn.textContent = cancelLabel;

    overlay.classList.remove("hidden");
    cancelBtn.focus();

    const cleanup = () => {
      overlay.classList.add("hidden");
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      overlay.removeEventListener("click", onOverlay);
      document.removeEventListener("keydown", onKey);
    };

    const onOk = () => { cleanup(); resolve(true); };
    const onCancel = () => { cleanup(); resolve(false); };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onCancel(); }
      if (e.key === "Enter") { e.preventDefault(); onOk(); }
    };

    const onOverlay = (e: MouseEvent) => {
      if (e.target === overlay) onCancel();
    };

    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    overlay.addEventListener("click", onOverlay);
    document.addEventListener("keydown", onKey);
  });
}
