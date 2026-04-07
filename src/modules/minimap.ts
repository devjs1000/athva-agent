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
    const width = 80;

    this.canvas.width = width * devicePixelRatio;
    this.canvas.height = containerHeight * devicePixelRatio;
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${containerHeight}px`;
    this.ctx.scale(devicePixelRatio, devicePixelRatio);

    // Background — match editor bg
    this.ctx.fillStyle = "#1e1e1e";
    this.ctx.fillRect(0, 0, width, containerHeight);

    // Line height: clamp between 1.5 and 4px
    const lineH = Math.max(1.5, Math.min(4, containerHeight / Math.max(lineCount, 1)));
    const maxLines = Math.floor(containerHeight / lineH);

    // Token colours (VSCode-inspired dark theme)
    const C = {
      keyword:  "#569cd6",
      type:     "#4ec9b0",
      string:   "#ce9178",
      comment:  "#6a9955",
      number:   "#b5cea8",
      operator: "#d4d4d4",
      fn:       "#dcdcaa",
      default:  "#606060",
    };

    for (let i = 0; i < Math.min(lineCount, maxLines); i++) {
      const line = session.getLine(i);
      if (!line || !line.trim()) continue;

      const y = i * lineH;
      const trimmed = line.trim();
      const indent = line.length - line.trimStart().length;
      const x = 4 + indent * 0.9;
      const maxW = width - x - 4;

      // Classify line
      let color = C.default;
      let alpha = 0.55;
      if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) {
        color = C.comment; alpha = 0.45;
      } else if (trimmed.startsWith('"') || trimmed.startsWith("'") || trimmed.startsWith("`")) {
        color = C.string; alpha = 0.7;
      } else if (/^\d/.test(trimmed)) {
        color = C.number; alpha = 0.7;
      } else if (/^(import|export|const|let|var|function|class|return|if|else|for|while|switch|case|async|await|from|interface|type|enum|extends|implements|new|throw|try|catch|finally|default|static|public|private|protected|readonly|override|abstract)\b/.test(trimmed)) {
        color = C.keyword; alpha = 0.75;
      } else if (/^[A-Z][a-zA-Z0-9_]*/.test(trimmed)) {
        color = C.type; alpha = 0.7;
      } else if (/^\w+\s*\(/.test(trimmed)) {
        color = C.fn; alpha = 0.65;
      }

      // Draw segments: indent gap + content bar
      const barW = Math.min(trimmed.length * 0.9, maxW);
      const h = Math.max(lineH - 0.6, 1);

      this.ctx.globalAlpha = alpha;
      this.ctx.fillStyle = color;
      this.ctx.beginPath();
      this.ctx.roundRect(x, y + 0.3, Math.max(barW, 3), h, 0.5);
      this.ctx.fill();
    }

    this.ctx.globalAlpha = 1;

    // Subtle horizontal rules every ~10 lines for orientation
    this.ctx.fillStyle = "rgba(255,255,255,0.025)";
    for (let i = 10; i < Math.min(lineCount, maxLines); i += 10) {
      this.ctx.fillRect(0, i * lineH, width, 0.5);
    }

    this.updateViewport();
  }

  private updateViewport() {
    if (!this.visible) return;

    const session = this.editor.session;
    const lineCount = session.getLength();
    const containerHeight = this.canvas.parentElement!.clientHeight;
    const lineH = Math.max(1.5, Math.min(4, containerHeight / Math.max(lineCount, 1)));

    const firstRow = this.editor.getFirstVisibleRow();
    const lastRow = this.editor.getLastVisibleRow();

    const top = firstRow * lineH;
    const height = Math.max((lastRow - firstRow + 1) * lineH, 12);

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
