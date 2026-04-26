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
  private decorations: string[] = [];
  private disposables: monaco.IDisposable[] = [];
  private enabled = true;

  constructor(editor: monaco.editor.IStandaloneCodeEditor) {
    this.editor = editor;
    this.disposables.push(
      monaco.editor.onDidChangeMarkers(([resource]) => {
        const model = this.editor.getModel();
        if (model && resource.toString() === model.uri.toString()) {
          this.refresh();
        }
      })
    );
    this.disposables.push(
      editor.onDidChangeModel(() => this.refresh())
    );
    this.refresh();
  }

  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    if (!enabled) {
      this.decorations = this.editor.deltaDecorations(this.decorations, []);
    } else {
      this.refresh();
    }
  }

  refresh() {
    const model = this.editor.getModel();
    if (!model || !this.enabled) {
      this.decorations = this.editor.deltaDecorations(this.decorations, []);
      return;
    }

    const markers = monaco.editor.getModelMarkers({ resource: model.uri });
    // Group by line — keep the highest-severity marker per line
    const byLine = new Map<number, monaco.editor.IMarker>();
    for (const marker of markers) {
      const existing = byLine.get(marker.startLineNumber);
      if (!existing || marker.severity > existing.severity) {
        byLine.set(marker.startLineNumber, marker);
      }
    }

    const next: monaco.editor.IModelDeltaDecoration[] = [];
    for (const [lineNumber, marker] of byLine) {
      const severityClass = SEVERITY_CLASS[marker.severity] ?? "error-lens-info";
      const prefix = SEVERITY_PREFIX[marker.severity] ?? "";
      const message = marker.message.split("\n")[0].trim();
      const label = prefix ? `${prefix}: ${message}` : message;

      next.push({
        range: new monaco.Range(lineNumber, 1, lineNumber, 1),
        options: {
          isWholeLine: true,
          className: `error-lens-line ${severityClass}-line`,
          after: {
            content: `  ${label}`,
            inlineClassName: `error-lens-message ${severityClass}-message`,
          },
        },
      });
    }

    this.decorations = this.editor.deltaDecorations(this.decorations, next);
  }

  dispose() {
    this.decorations = this.editor.deltaDecorations(this.decorations, []);
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
  }
}
