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

/** Render CSV as an HTML table */
export function renderCSVPreview(csv: string): string {
  const { headers, rows } = parseCSV(csv);

  if (rows.length === 0) {
    return '<div class="preview-empty">No data</div>';
  }

  const headerRow = headers
    .map((h) => `<th class="preview-th">${escHtml(h)}</th>`)
    .join("");

  const dataRows = rows
    .map(
      (row) =>
        `<tr>${row
          .map((cell) => `<td class="preview-td">${escHtml(cell)}</td>`)
          .join("")}</tr>`
    )
    .join("");

  return `
    <div class="spreadsheet-container">
      <table class="preview-table">
        <thead><tr>${headerRow}</tr></thead>
        <tbody>${dataRows}</tbody>
      </table>
    </div>
  `;
}

/** Render mermaid diagram */
export async function renderFlowPreview(mermaidCode: string): Promise<string> {
  try {
    const mermaid = await getMermaid();
    if (!mermaid) {
      return `<div class="preview-error">Failed to load mermaid library</div>`;
    }

    const id = `mermaid-${Date.now()}`;
    // Return HTML with mermaid class — will be rendered after DOM insertion
    // Note: mermaid will process this and render the diagram when mermaid.run() is called
    return `<div class="mermaid-container"><div id="${id}" class="mermaid">${mermaidCode}</div></div>`;
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

  return `<div class="text-document-container">${formatted}</div>`;
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
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) return '<div class="preview-empty">Empty workbook</div>';

    const sheet = workbook.Sheets[sheetName];
    const data: string[][] = XLSX.utils.sheet_to_json(sheet, { header: 1 });

    if (data.length === 0) {
      return '<div class="preview-empty">No data in sheet</div>';
    }

    const [headerRow, ...dataRows] = data;
    const headerHtml = (headerRow ?? [])
      .map((h) => `<th class="preview-th">${escHtml(String(h ?? ""))}</th>`)
      .join("");

    const rowsHtml = dataRows
      .map(
        (row) =>
          `<tr>${(row ?? [])
            .map((cell) => `<td class="preview-td">${escHtml(String(cell ?? ""))}</td>`)
            .join("")}</tr>`
      )
      .join("");

    return `
      <div class="spreadsheet-container">
        <div class="sheet-tabs">
          ${workbook.SheetNames.map(
            (name: string, i: number) =>
              `<button class="sheet-tab${i === 0 ? " active" : ""}">${escHtml(name)}</button>`
          ).join("")}
        </div>
        <table class="preview-table">
          <thead><tr>${headerHtml}</tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
    `;
  } catch (e) {
    return `<div class="preview-error">Failed to parse XLSX: ${escHtml(String(e))}</div>`;
  }
}

/** Helper for sheet tab rendering (currently unused, kept for future multi-sheet support) */
export function formatSheetName(name: string, _index: number): string {
  return escHtml(name);
}
