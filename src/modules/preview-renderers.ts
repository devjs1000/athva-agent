/**
 * File type preview renderers.
 * Handles .flow (mermaid), .csv/.xlsx (spreadsheet), .txt (document), etc.
 */

let mermaidModule: any = null;

/** Lazy-load mermaid module on first use */
async function getMermaid() {
  if (!mermaidModule) {
    try {
      mermaidModule = await import("mermaid");
      const mermaid = mermaidModule.default;

      // Initialize mermaid with proper config
      mermaid.initialize({
        startOnLoad: false,
        theme: "dark",
        securityLevel: "loose",
        flowchart: {
          useMaxWidth: true,
          htmlLabels: true
        }
      });

      // Make mermaid available globally for the editor to use
      (globalThis as any).mermaid = mermaid;
    } catch (e) {
      console.error("Failed to load mermaid:", e);
      return null;
    }
  }
  return mermaidModule.default;
}

/** Simple CSV parser — handles basic cases without external lib */
export function parseCSV(csv: string): { headers: string[]; rows: string[][] } {
  const lines = csv.trim().split("\n");
  if (lines.length === 0) return { headers: [], rows: [] };

  const headers = parseCsvLine(lines[0]);
  const rows = lines.slice(1).map((line) => parseCsvLine(line));
  return { headers, rows };
}

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const nextChar = line[i + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        current += '"';
        i++; // skip next quote
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      result.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function countColumns(headers: string[], rows: string[][]): number {
  return rows.reduce((max, row) => Math.max(max, row.length), headers.length);
}

function renderSpreadsheetTable(headers: string[], rows: string[][]): string {
  const columnCount = countColumns(headers, rows);
  const normalizedHeaders = Array.from({ length: columnCount }, (_, index) => {
    const label = headers[index]?.trim();
    return label && label.length > 0 ? label : `Column ${index + 1}`;
  });

  const headerRow = `
    <tr>
      <th class="preview-row-index preview-row-index-head">#</th>
      ${normalizedHeaders
        .map((header) => `<th class="preview-th" title="${escHtml(header)}">${escHtml(header)}</th>`)
        .join("")}
    </tr>
  `;

  const dataRows = rows
    .map((row, rowIndex) => {
      const cells = Array.from({ length: columnCount }, (_, columnIndex) => row[columnIndex] ?? "");
      return `
        <tr>
          <td class="preview-row-index">${rowIndex + 1}</td>
          ${cells
            .map((cell) => {
              const value = String(cell ?? "");
              return `<td class="preview-td" title="${escHtml(value)}">${escHtml(value) || "&nbsp;"}</td>`;
            })
            .join("")}
        </tr>
      `;
    })
    .join("");

  return `
    <div class="preview-grid-wrap">
      <table class="preview-table">
        <thead>${headerRow}</thead>
        <tbody>${dataRows}</tbody>
      </table>
    </div>
  `;
}

function renderPreviewMeta(items: Array<[string, string]>): string {
  return items
    .map(([label, value]) => `<span class="preview-meta-pill"><strong>${escHtml(label)}</strong>${escHtml(value)}</span>`)
    .join("");
}

function renderSpreadsheetShell(title: string, subtitle: string, meta: Array<[string, string]>, body: string): string {
  return `
    <div class="spreadsheet-container" data-preview-shell="spreadsheet">
      <div class="preview-shell-header">
        <div class="preview-shell-copy">
          <span class="preview-shell-eyebrow">Data Preview</span>
          <h2 class="preview-shell-title">${escHtml(title)}</h2>
          <p class="preview-shell-subtitle">${escHtml(subtitle)}</p>
        </div>
        <div class="preview-meta-row">
          ${renderPreviewMeta(meta)}
        </div>
      </div>
      ${body}
    </div>
  `;
}

interface WorkbookSheetPreview {
  name: string;
  rowCount: number;
  columnCount: number;
  html: string;
}

/** Render CSV as an HTML table */
export function renderCSVPreview(csv: string): string {
  const { headers, rows } = parseCSV(csv);

  if (headers.length === 0 && rows.length === 0) {
    return '<div class="preview-empty">No data</div>';
  }

  return renderSpreadsheetShell(
    "CSV Preview",
    "Structured table view for comma-separated data.",
    [
      ["Rows", String(rows.length)],
      ["Columns", String(countColumns(headers, rows))],
    ],
    renderSpreadsheetTable(headers, rows)
  );
}

/** Render mermaid diagram */
export async function renderFlowPreview(mermaidCode: string): Promise<string> {
  try {
    const mermaid = await getMermaid();
    if (!mermaid) {
      return `<div class="preview-error">Failed to load mermaid library</div>`;
    }

    const id = `mermaid-${Date.now()}`;
    return `
      <div class="mermaid-container">
        <div class="mermaid-toolbar">
          <div class="mermaid-toolbar-copy">
            <span class="mermaid-toolbar-title">Flow Preview</span>
            <span class="mermaid-toolbar-subtitle">Zoom with buttons or Cmd/Ctrl + scroll</span>
          </div>
          <div class="mermaid-toolbar-actions">
            <button type="button" class="mermaid-zoom-btn" data-mermaid-zoom="out">-</button>
            <button type="button" class="mermaid-zoom-btn" data-mermaid-zoom="reset">100%</button>
            <button type="button" class="mermaid-zoom-btn" data-mermaid-zoom="in">+</button>
          </div>
        </div>
        <div class="mermaid-stage" data-mermaid-stage>
          <div class="mermaid-scale-wrap" data-mermaid-scale="1">
            <div id="${id}" class="mermaid">${mermaidCode}</div>
          </div>
        </div>
      </div>
    `;
  } catch (e) {
    return `<div class="preview-error">Failed to render diagram: ${escHtml(String(e))}</div>`;
  }
}

/** Render .txt as a formatted document */
export function renderTextPreview(text: string): string {
  // Simple formatting: preserve line breaks, auto-link URLs
  const lines = text.split("\n");
  const formatted = lines
    .map((line) => {
      let html = escHtml(line);
      // Auto-link URLs
      html = html.replace(
        /(https?:\/\/[^\s]+)/g,
        '<a href="$1" class="preview-link" target="_blank">$1</a>'
      );
      // Bold headers (lines starting with # or all caps)
      if (line.trim().startsWith("#") || /^[A-Z\s]+$/.test(line.trim())) {
        html = `<strong>${html}</strong>`;
      }
      return `<p class="preview-text-line">${html}</p>`;
    })
    .join("");

  return `
    <div class="text-document-container">
      <div class="preview-shell-header">
        <div class="preview-shell-copy">
          <span class="preview-shell-eyebrow">Document Preview</span>
          <h2 class="preview-shell-title">Text Preview</h2>
          <p class="preview-shell-subtitle">Readable document layout with link detection and preserved spacing.</p>
        </div>
        <div class="preview-meta-row">
          ${renderPreviewMeta([
            ["Lines", String(lines.length)],
            ["Words", String(text.trim() ? text.trim().split(/\s+/).length : 0)],
          ])}
        </div>
      </div>
      <article class="text-document-paper">${formatted}</article>
    </div>
  `;
}

/** Try to load XLSX file and render as table — requires xlsx lib */
export async function renderXlsxPreview(arrayBuffer: ArrayBuffer): Promise<string> {
  try {
    // @ts-ignore — xlsx is injected at runtime
    const XLSX = (globalThis as any).XLSX;
    if (!XLSX) {
      return `<div class="preview-error">XLSX library not loaded. Install via npm or add &lt;script&gt; tag.</div>`;
    }

    const workbook = XLSX.read(new Uint8Array(arrayBuffer), { type: "array" });
    const sheetNames = workbook.SheetNames ?? [];
    const firstSheetName = sheetNames[0];
    if (!firstSheetName) return '<div class="preview-empty">Empty workbook</div>';

    const sheetPanels: WorkbookSheetPreview[] = sheetNames
      .map((sheetName: string, index: number) => {
        const sheet = workbook.Sheets[sheetName];
        const data: string[][] = XLSX.utils.sheet_to_json(sheet, { header: 1 });
        const [headerRow = [], ...dataRows] = data;
        const columnCount = countColumns(
          headerRow.map((cell) => String(cell ?? "")),
          dataRows.map((row) => (row ?? []).map((cell) => String(cell ?? "")))
        );

        return {
          name: sheetName,
          rowCount: dataRows.length,
          columnCount,
          html: `
            <section class="sheet-panel${index === 0 ? " active" : ""}" data-sheet-panel="${index}">
              ${renderSpreadsheetTable(
                headerRow.map((cell) => String(cell ?? "")),
                dataRows.map((row) => (row ?? []).map((cell) => String(cell ?? "")))
              )}
            </section>
          `,
        };
      });

    if (sheetPanels.length === 0) {
      return '<div class="preview-empty">No data in sheet</div>';
    }

    return renderSpreadsheetShell(
      "Workbook Preview",
      "Switch between sheets without leaving the preview surface.",
      [
        ["Sheets", String(sheetPanels.length)],
        ["Active", firstSheetName],
      ],
      `
        <div class="sheet-tabs" role="tablist" aria-label="Workbook sheets">
          ${sheetPanels
            .map(
              (sheet, index) => `
                <button
                  type="button"
                  class="sheet-tab${index === 0 ? " active" : ""}"
                  data-sheet-target="${index}"
                  data-sheet-name="${escHtml(sheet.name)}"
                  role="tab"
                  aria-selected="${index === 0 ? "true" : "false"}"
                >
                  <span class="sheet-tab-name">${escHtml(sheet.name)}</span>
                  <span class="sheet-tab-meta">${sheet.rowCount}r / ${sheet.columnCount}c</span>
                </button>
              `
            )
            .join("")}
        </div>
        <div class="sheet-panels">
          ${sheetPanels.map((sheet) => sheet.html).join("")}
        </div>
      `,
    );
  } catch (e) {
    return `<div class="preview-error">Failed to parse XLSX: ${escHtml(String(e))}</div>`;
  }
}

/** Helper for sheet tab rendering (currently unused, kept for future multi-sheet support) */
export function formatSheetName(name: string, _index: number): string {
  return escHtml(name);
}
