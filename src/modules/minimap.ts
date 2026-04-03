// Lightweight canvas-based minimap for Ace editor

export class Minimap {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private editor: any; // Ace editor instance
  private visible = false;
  private viewport: HTMLDivElement;
  private isDragging = false;
  private renderTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(editorContainer: HTMLElement, aceEditor: any) {
    this.editor = aceEditor;

    // Create minimap container
    this.canvas = document.createElement("canvas");
    this.canvas.className = "minimap-canvas";
    editorContainer.appendChild(this.canvas);

    // Viewport highlight
    this.viewport = document.createElement("div");
    this.viewport.className = "minimap-viewport";
    editorContainer.appendChild(this.viewport);

    this.ctx = this.canvas.getContext("2d")!;

    // Scroll sync
    this.editor.session.on("changeScrollTop", () => this.updateViewport());
    this.editor.session.on("change", () => this.scheduleRender());
    this.editor.renderer.on("resize", () => this.scheduleRender());

    // Click/drag to scroll
    this.canvas.addEventListener("mousedown", (e) => this.onMouseDown(e));
    this.viewport.addEventListener("mousedown", (e) => this.onMouseDown(e));
    document.addEventListener("mousemove", (e) => this.onMouseMove(e));
    document.addEventListener("mouseup", () => (this.isDragging = false));
  }

  show() {
    this.visible = true;
    this.canvas.style.display = "block";
    this.viewport.style.display = "block";
    this.render();
  }

  hide() {
    this.visible = false;
    this.canvas.style.display = "none";
    this.viewport.style.display = "none";
  }

  setVisible(v: boolean) {
    v ? this.show() : this.hide();
  }

  scheduleRender() {
    if (!this.visible) return;
    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.renderTimer = setTimeout(() => this.render(), 50);
  }

  private render() {
    if (!this.visible) return;

    const session = this.editor.session;
    const lineCount = session.getLength();
    const containerHeight = this.canvas.parentElement!.clientHeight;
    const width = 60;

    this.canvas.width = width * devicePixelRatio;
    this.canvas.height = containerHeight * devicePixelRatio;
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${containerHeight}px`;
    this.ctx.scale(devicePixelRatio, devicePixelRatio);

    // Background
    this.ctx.fillStyle = "#1a1a1a";
    this.ctx.fillRect(0, 0, width, containerHeight);

    // Calculate line height in minimap
    const lineH = Math.max(2, Math.min(3, containerHeight / Math.max(lineCount, 1)));
    const maxLines = Math.floor(containerHeight / lineH);

    // Colors for code representation
    const colors: Record<string, string> = {
      keyword: "#569cd6",
      string: "#ce9178",
      comment: "#6a9955",
      number: "#b5cea8",
      default: "#808080",
    };

    for (let i = 0; i < Math.min(lineCount, maxLines); i++) {
      const line = session.getLine(i);
      if (!line || line.trim().length === 0) continue;

      const y = i * lineH;
      const indent = line.length - line.trimStart().length;
      const trimmed = line.trim();

      // Simple heuristic coloring
      let color = colors.default;
      if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) {
        color = colors.comment;
      } else if (trimmed.startsWith('"') || trimmed.startsWith("'") || trimmed.startsWith("`")) {
        color = colors.string;
      } else if (/^(import|export|const|let|var|function|class|if|else|return|for|while|switch|case|async|await|from|interface|type|enum)\b/.test(trimmed)) {
        color = colors.keyword;
      }

      this.ctx.fillStyle = color;
      const x = 2 + indent * 0.8;
      const barWidth = Math.min(trimmed.length * 0.8, width - x - 2);
      this.ctx.globalAlpha = 0.6;
      this.ctx.fillRect(x, y, Math.max(barWidth, 2), Math.max(lineH - 0.5, 1));
    }

    this.ctx.globalAlpha = 1;
    this.updateViewport();
  }

  private updateViewport() {
    if (!this.visible) return;

    const session = this.editor.session;
    const lineCount = session.getLength();
    const containerHeight = this.canvas.parentElement!.clientHeight;
    const lineH = Math.max(2, Math.min(3, containerHeight / Math.max(lineCount, 1)));

    const firstRow = this.editor.getFirstVisibleRow();
    const lastRow = this.editor.getLastVisibleRow();

    const top = firstRow * lineH;
    const height = Math.max((lastRow - firstRow + 1) * lineH, 10);

    this.viewport.style.top = `${top}px`;
    this.viewport.style.height = `${height}px`;
  }

  private onMouseDown(e: MouseEvent) {
    e.preventDefault();
    this.isDragging = true;
    this.scrollToY(e.clientY);
  }

  private onMouseMove(e: MouseEvent) {
    if (!this.isDragging) return;
    this.scrollToY(e.clientY);
  }

  private scrollToY(clientY: number) {
    const rect = this.canvas.getBoundingClientRect();
    const ratio = (clientY - rect.top) / rect.height;
    const lineCount = this.editor.session.getLength();
    const targetLine = Math.floor(ratio * lineCount);
    this.editor.scrollToLine(targetLine, true, false, () => {});
  }
}
