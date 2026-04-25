/**
 * Inline color highlighting for Monaco editor.
 *
 * Each color value in the code gets a semi-transparent colored background
 * (the color's own hue, tinted).  Clicking the highlighted text opens a
 * small floating popup containing a real <input type="color"> — the user
 * clicks it directly so the OS native color dialog opens reliably.
 * The chosen value is written back in the original format.
 */

import * as monaco from "monaco-editor";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ColorMatch {
  raw: string;    // original text  e.g. "#f00", "rgba(255,0,0,.5)"
  hex: string;    // #RRGGBB for <input type="color">
  line: number;   // 1-based
  column: number; // 1-based, start of raw
}

// ─────────────────────────────────────────────────────────────────────────────
// Math helpers
// ─────────────────────────────────────────────────────────────────────────────

function hexExpand(h: string): string {
  if (h.length === 3) return h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
  if (h.length === 4) return h[0]+h[0]+h[1]+h[1]+h[2]+h[2]+h[3]+h[3];
  return h;
}

function clamp255(v: number) { return Math.max(0, Math.min(255, Math.round(v))); }

function rgbToHex(r: number, g: number, b: number): string {
  return "#" + [r, g, b].map(v => clamp255(v).toString(16).padStart(2, "0")).join("");
}

function hslToHex(h: number, s: number, l: number): string {
  s /= 100; l /= 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const c = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * c).toString(16).padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

function hexToHsl(hex: string): [number, number, number] {
  const r = parseInt(hex.slice(1,3),16)/255;
  const g = parseInt(hex.slice(3,5),16)/255;
  const b = parseInt(hex.slice(5,7),16)/255;
  const max = Math.max(r,g,b), min = Math.min(r,g,b);
  let h = 0, s = 0;
  const l = (max+min)/2;
  if (max !== min) {
    const d = max-min;
    s = l > 0.5 ? d/(2-max-min) : d/(max+min);
    switch (max) {
      case r: h = ((g-b)/d + (g<b?6:0))/6; break;
      case g: h = ((b-r)/d + 2)/6; break;
      case b: h = ((r-g)/d + 4)/6; break;
    }
  }
  return [Math.round(h*360), Math.round(s*100), Math.round(l*100)];
}

// ─────────────────────────────────────────────────────────────────────────────
// Scanner
// ─────────────────────────────────────────────────────────────────────────────

const PATTERNS: { re: RegExp; toHex: (m: RegExpExecArray) => string }[] = [
  {
    re: /#([0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b/g,
    toHex: m => "#" + hexExpand(m[1]).slice(0,6),
  },
  {
    re: /rgba?\(\s*(\d{1,3})\s*[,\s]\s*(\d{1,3})\s*[,\s]\s*(\d{1,3})(?:\s*[,\/]\s*[\d.]+%?)?\s*\)/gi,
    toHex: m => rgbToHex(+m[1], +m[2], +m[3]),
  },
  {
    re: /hsla?\(\s*([\d.]+)\s*[,\s]\s*([\d.]+)%\s*[,\s]\s*([\d.]+)%(?:\s*[,\/]\s*[\d.]+%?)?\s*\)/gi,
    toHex: m => hslToHex(+m[1], +m[2], +m[3]),
  },
];

export function findColors(text: string): ColorMatch[] {
  const results: ColorMatch[] = [];
  const lines = text.split("\n");
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const lineNum = li + 1;
    for (const { re, toHex } of PATTERNS) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(line)) !== null) {
        try { results.push({ raw: m[0], hex: toHex(m), line: lineNum, column: m.index+1 }); }
        catch { /* skip malformed */ }
      }
    }
  }
  results.sort((a,b) => a.line !== b.line ? a.line-b.line : a.column-b.column);
  const out: ColorMatch[] = [];
  for (const c of results) {
    const prev = out[out.length-1];
    if (prev && prev.line === c.line && c.column < prev.column+prev.raw.length) continue;
    out.push(c);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main class
// ─────────────────────────────────────────────────────────────────────────────

const MAX_COLORS = 500;

export class ColorHighlighter {
  private editor: monaco.editor.IStandaloneCodeEditor;
  private decorations: monaco.editor.IEditorDecorationsCollection;
  private styleEl: HTMLStyleElement;
  private popup: HTMLDivElement;
  private popupInput: HTMLInputElement;
  private colors: ColorMatch[] = [];
  private pending: ColorMatch | null = null;
  private debounceId: ReturnType<typeof setTimeout> | null = null;
  private disposables: monaco.IDisposable[] = [];
  private _domHandler: (e: MouseEvent) => void;
  private _outsideHandler: (e: MouseEvent) => void;

  constructor(editor: monaco.editor.IStandaloneCodeEditor) {
    this.editor = editor;
    this.decorations = editor.createDecorationsCollection([]);

    // Stylesheet for per-color background tints
    this.styleEl = document.createElement("style");
    this.styleEl.id = "color-highlighter-styles";
    document.head.appendChild(this.styleEl);

    // ── Floating picker popup ──────────────────────────────────────────────
    // The popup holds a *visible* <input type="color"> so the user clicks it
    // directly — programmatic .click() is unreliable in Tauri's WKWebView.
    this.popup = document.createElement("div");
    this.popup.className = "ch-picker-popup";
    this.popup.innerHTML = `
      <div class="ch-picker-label">Pick color</div>
      <input class="ch-picker-input" type="color" />
      <div class="ch-picker-hint">Click swatch to open OS picker</div>
    `;
    document.body.appendChild(this.popup);

    this.popupInput = this.popup.querySelector(".ch-picker-input") as HTMLInputElement;
    this.popupInput.addEventListener("input", () => this.applyColor(this.popupInput.value));

    // Close popup when clicking outside
    this._outsideHandler = (e: MouseEvent) => {
      if (!this.popup.contains(e.target as Node)) this.hidePopup();
    };

    // Editor click handler (capture phase for reliable class traversal)
    this._domHandler = (e: MouseEvent) => this.handleDOMClick(e);
    editor.getContainerDomNode().addEventListener("mousedown", this._domHandler, true);

    // React to content changes
    this.disposables.push(
      editor.onDidChangeModelContent(() => this.schedule()),
      editor.onDidChangeModel(() => this.schedule()),
    );

    this.schedule();
  }

  // ── Refresh ────────────────────────────────────────────────────────────────

  private schedule() {
    if (this.debounceId) clearTimeout(this.debounceId);
    this.debounceId = setTimeout(() => this.refresh(), 250);
  }

  private refresh() {
    const model = this.editor.getModel();
    if (!model) { this.clear(); return; }

    this.colors = findColors(model.getValue()).slice(0, MAX_COLORS);

    const rules: string[] = [];
    const decos: monaco.editor.IModelDeltaDecoration[] = [];

    this.colors.forEach((c, i) => {
      const cls = `_ch${i}`;
      const r = parseInt(c.hex.slice(1,3),16);
      const g = parseInt(c.hex.slice(3,5),16);
      const b = parseInt(c.hex.slice(5,7),16);

      // Semi-transparent background tint using the actual color — no box, no layout shift
      rules.push(
        `.monaco-editor .view-lines span.${cls}{` +
        `background:rgba(${r},${g},${b},0.28);` +
        `border-radius:3px;cursor:pointer;` +
        `outline:1px solid rgba(${r},${g},${b},0.55);outline-offset:-1px;}`
      );

      decos.push({
        range: new monaco.Range(c.line, c.column, c.line, c.column + c.raw.length),
        options: { inlineClassName: `_color_hl ${cls}` },
      });
    });

    this.styleEl.textContent = rules.join("\n");
    this.decorations.set(decos);
  }

  private clear() {
    this.decorations.set([]);
    this.styleEl.textContent = "";
    this.colors = [];
  }

  // ── Click handling ─────────────────────────────────────────────────────────

  private handleDOMClick(e: MouseEvent) {
    const target = e.target as HTMLElement | null;
    if (!target) return;

    // closest() walks up through Monaco's nested syntax token spans
    const hlEl = target.classList.contains("_color_hl")
      ? target
      : (target.closest("._color_hl") as HTMLElement | null);
    if (!hlEl) return;

    // Get Monaco model position from screen coords
    const editorTarget = this.editor.getTargetAtClientPoint(e.clientX, e.clientY);
    const pos = editorTarget?.position;
    if (!pos) return;

    const color = this.colors.find(c =>
      c.line === pos.lineNumber &&
      pos.column >= c.column &&
      pos.column <= c.column + c.raw.length
    );
    if (!color) return;

    // Stop Monaco from placing a cursor on this click
    e.preventDefault();
    e.stopPropagation();

    this.showPopup(color, e.clientX, e.clientY);
  }

  // ── Popup ──────────────────────────────────────────────────────────────────

  private showPopup(color: ColorMatch, x: number, y: number) {
    this.pending = color;
    this.popupInput.value = color.hex.slice(0, 7);

    // Position popup near the click, keeping it on screen
    const vw = window.innerWidth, vh = window.innerHeight;
    const pw = 180, ph = 80;
    const left = Math.min(x + 4, vw - pw - 8);
    const top  = Math.min(y + 4, vh - ph - 8);

    this.popup.style.left = `${left}px`;
    this.popup.style.top  = `${top}px`;
    this.popup.classList.add("ch-picker-popup--visible");

    // Dismiss on outside click (next tick so this mousedown doesn't count)
    setTimeout(() => {
      document.addEventListener("mousedown", this._outsideHandler, { once: true });
    }, 0);
  }

  private hidePopup() {
    this.popup.classList.remove("ch-picker-popup--visible");
    this.pending = null;
  }

  // ── Apply ──────────────────────────────────────────────────────────────────

  private applyColor(newHex: string) {
    if (!this.pending) return;
    const match = this.pending;
    const model = this.editor.getModel();
    if (!model) return;

    const converted = this.reformat(match.raw, newHex);
    model.pushEditOperations([], [{
      range: new monaco.Range(match.line, match.column, match.line, match.column + match.raw.length),
      text: converted,
    }], () => null);

    this.pending = { ...match, raw: converted, hex: newHex };
  }

  private reformat(original: string, newHex: string): string {
    const t = original.trim();
    const r = parseInt(newHex.slice(1,3),16);
    const g = parseInt(newHex.slice(3,5),16);
    const b = parseInt(newHex.slice(5,7),16);

    if (t.startsWith("#")) {
      switch (t.length) {
        case 4: return `#${Math.round(r/17).toString(16)}${Math.round(g/17).toString(16)}${Math.round(b/17).toString(16)}`;
        case 5: return `#${Math.round(r/17).toString(16)}${Math.round(g/17).toString(16)}${Math.round(b/17).toString(16)}${t[4]}`;
        case 9: return newHex + t.slice(7);
        default: return newHex;
      }
    }

    if (/^rgba?\s*\(/i.test(t)) {
      const alpha = t.match(/[,\/]\s*([\d.]+%?)\s*\)$/)?.[1];
      return alpha ? `rgba(${r}, ${g}, ${b}, ${alpha})` : `rgb(${r}, ${g}, ${b})`;
    }

    if (/^hsla?\s*\(/i.test(t)) {
      const [h, s, l] = hexToHsl(newHex);
      const alpha = t.match(/[,\/]\s*([\d.]+%?)\s*\)$/)?.[1];
      return alpha ? `hsla(${h}, ${s}%, ${l}%, ${alpha})` : `hsl(${h}, ${s}%, ${l}%)`;
    }

    return newHex;
  }

  // ── Dispose ────────────────────────────────────────────────────────────────

  dispose() {
    if (this.debounceId) clearTimeout(this.debounceId);
    this.disposables.forEach(d => d.dispose());
    this.editor.getContainerDomNode().removeEventListener("mousedown", this._domHandler, true);
    document.removeEventListener("mousedown", this._outsideHandler);
    this.decorations.set([]);
    this.styleEl.remove();
    this.popup.remove();
  }
}
