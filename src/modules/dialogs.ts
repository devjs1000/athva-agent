// Custom dialog replacements for prompt(), confirm(), alert()
// since native dialogs are blocked in Tauri WebView

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
