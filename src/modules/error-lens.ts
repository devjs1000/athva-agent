import * as monaco from "monaco-editor";

const SEVERITY_CLASS: Record<number, string> = {
  [monaco.MarkerSeverity.Error]: "error-lens-error",
  [monaco.MarkerSeverity.Warning]: "error-lens-warning",
  [monaco.MarkerSeverity.Info]: "error-lens-info",
  [monaco.MarkerSeverity.Hint]: "error-lens-hint",
};

const SEVERITY_PREFIX: Record<number, string> = {
  [monaco.MarkerSeverity.Error]: "Error",
  [monaco.MarkerSeverity.Warning]: "Warning",
  [monaco.MarkerSeverity.Info]: "Info",
  [monaco.MarkerSeverity.Hint]: "Hint",
};

export class ErrorLens {
  private editor: monaco.editor.IStandaloneCodeEditor;
  private collection: monaco.editor.IEditorDecorationsCollection;
  private disposables: monaco.IDisposable[] = [];
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(editor: monaco.editor.IStandaloneCodeEditor) {
    this.editor = editor;
    this.collection = editor.createDecorationsCollection([]);

    // onDidChangeMarkers fires with the full array of changed URIs — check all of them
    this.disposables.push(
      monaco.editor.onDidChangeMarkers((resources) => {
        const model = this.editor.getModel();
        if (!model) return;
        const modelUri = model.uri.toString();
        if (resources.some((r) => r.toString() === modelUri)) {
          this.refresh();
        }
      })
    );

    // When the active model changes, refresh immediately
    this.disposables.push(
      editor.onDidChangeModel(() => this.refresh())
    );

    // TS worker fires markers after a debounce on content change — schedule a
    // delayed refresh so we catch them even if onDidChangeMarkers fires late
    this.disposables.push(
      editor.onDidChangeModelContent(() => this.scheduleRefresh(800))
    );

    this.refresh();
  }

  private scheduleRefresh(delay: number) {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => this.refresh(), delay);
  }

  refresh() {
    const model = this.editor.getModel();
    if (!model) {
      this.collection.clear();
      return;
    }

    const markers = monaco.editor.getModelMarkers({ resource: model.uri });

    // One decoration per line — highest severity wins
    const byLine = new Map<number, monaco.editor.IMarker>();
    for (const marker of markers) {
      const existing = byLine.get(marker.startLineNumber);
      if (!existing || marker.severity > existing.severity) {
        byLine.set(marker.startLineNumber, marker);
      }
    }

    const next: monaco.editor.IModelDeltaDecoration[] = [];
    for (const [lineNumber, marker] of byLine) {
      const cls = SEVERITY_CLASS[marker.severity] ?? "error-lens-info";
      const prefix = SEVERITY_PREFIX[marker.severity] ?? "";
      const message = marker.message.split("\n")[0].trim();
      const label = prefix ? `${prefix}: ${message}` : message;

      next.push({
        range: new monaco.Range(lineNumber, 1, lineNumber, 1),
        options: {
          isWholeLine: true,
          className: `error-lens-line ${cls}-line`,
          after: {
            content: `  ${label}`,
            inlineClassName: `error-lens-message ${cls}-message`,
          },
        },
      });
    }

    this.collection.set(next);
  }

  dispose() {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.collection.clear();
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
  }
}
