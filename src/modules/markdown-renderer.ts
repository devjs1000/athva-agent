/**
 * Lightweight Markdown → HTML renderer.
 * Handles the common GFM subset: headings, bold/italic/strikethrough, code blocks,
 * inline code, links, images, blockquotes, ordered/unordered lists, tables, and
 * horizontal rules. No external dependencies required.
 */

function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Apply inline spans: bold, italic, strike, code, links, images */
function inlineFormat(s: string): string {
  return (
    s
      // bold+italic
      .replace(/\*\*\*([^*\n]+)\*\*\*/g, "<strong><em>$1</em></strong>")
      // bold
      .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
      .replace(/__([^_\n]+)__/g, "<strong>$1</strong>")
      // italic
      .replace(/\*([^*\n]+)\*/g, "<em>$1</em>")
      .replace(/_([^_\n]+)_/g, "<em>$1</em>")
      // strikethrough
      .replace(/~~([^~\n]+)~~/g, "<del>$1</del>")
      // images (before links)
      .replace(
        /!\[([^\]]*)\]\(([^)]+)\)/g,
        '<img src="$2" alt="$1" class="md-img" />'
      )
      // links
      .replace(
        /\[([^\]]+)\]\(([^)]+)\)/g,
        '<a href="$2" class="md-link" target="_blank" rel="noopener">$1</a>'
      )
  );
}

export function renderMarkdown(source: string): string {
  // ── 1. Protect fenced code blocks ─────────────────────────────────────────
  const codeBlocks: string[] = [];
  let s = source.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, lang, body: string) => {
    const idx = codeBlocks.length;
    const safeBody = escHtml(body.trimEnd());
    const cls = lang ? ` class="language-${lang}"` : "";
    codeBlocks.push(`<pre class="md-pre"><code${cls}>${safeBody}</code></pre>`);
    return `\x00CB${idx}\x00`;
  });

  // ── 2. Protect inline code ─────────────────────────────────────────────────
  const inlineCodes: string[] = [];
  s = s.replace(/`([^`\n]+)`/g, (_m, body: string) => {
    const idx = inlineCodes.length;
    inlineCodes.push(`<code class="md-code">${escHtml(body)}</code>`);
    return `\x00IC${idx}\x00`;
  });

  // ── 3. Line-by-line pass ───────────────────────────────────────────────────
  const lines = s.split("\n");
  const out: string[] = [];
  let listStack: Array<"ul" | "ol"> = [];

  const closeList = () => {
    while (listStack.length) {
      out.push(`</${listStack.pop()}>`);
    }
  };

  let inTable = false;
  let tableHasHead = false;

  const closeTable = () => {
    if (!inTable) return;
    if (tableHasHead) out.push("</tbody>");
    out.push("</table>");
    inTable = false;
    tableHasHead = false;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const raw = line.trim();

    // Code block placeholder
    if (/^\x00CB\d+\x00$/.test(raw)) {
      closeList();
      closeTable();
      out.push(line);
      continue;
    }

    // ── Headings ──────────────────────────────────────────────────────────────
    const hm = raw.match(/^(#{1,6})\s+(.+)$/);
    if (hm) {
      closeList();
      closeTable();
      const lvl = hm[1].length;
      out.push(`<h${lvl} class="md-h${lvl}">${inlineFormat(hm[2])}</h${lvl}>`);
      continue;
    }

    // ── Horizontal rule ───────────────────────────────────────────────────────
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(raw)) {
      closeList();
      closeTable();
      out.push('<hr class="md-hr" />');
      continue;
    }

    // ── Blockquote ────────────────────────────────────────────────────────────
    if (raw.startsWith("> ")) {
      closeList();
      closeTable();
      out.push(
        `<blockquote class="md-blockquote">${inlineFormat(raw.slice(2))}</blockquote>`
      );
      continue;
    }

    // ── Table row ─────────────────────────────────────────────────────────────
    if (raw.startsWith("|") && raw.endsWith("|")) {
      closeList();
      const cells = raw
        .slice(1, -1)
        .split("|")
        .map((c) => c.trim());

      // Separator row (|---|---|)
      if (cells.every((c) => /^:?-+:?$/.test(c))) {
        if (inTable) {
          out.push("</thead><tbody>");
          tableHasHead = true;
        }
        continue;
      }

      if (!inTable) {
        out.push('<table class="md-table"><thead>');
        inTable = true;
      }
      const tag = tableHasHead ? "td" : "th";
      out.push(
        `<tr>${cells
          .map((c) => `<${tag} class="md-td">${inlineFormat(c)}</${tag}>`)
          .join("")}</tr>`
      );
      continue;
    } else if (inTable) {
      closeTable();
    }

    // ── Unordered list ────────────────────────────────────────────────────────
    const ulm = line.match(/^(\s*)[*\-+]\s+(.+)$/);
    if (ulm) {
      closeTable();
      const depth = Math.floor(ulm[1].length / 2);
      while (listStack.length > depth + 1) out.push(`</${listStack.pop()}>`);
      if (listStack.length === depth || (listStack.length > 0 && listStack[listStack.length - 1] !== "ul")) {
        if (listStack.length > 0 && listStack[listStack.length - 1] !== "ul") {
          out.push(`</${listStack.pop()}>`);
        }
        out.push('<ul class="md-ul">');
        listStack.push("ul");
      }
      out.push(`<li class="md-li">${inlineFormat(ulm[2])}</li>`);
      continue;
    }

    // ── Ordered list ──────────────────────────────────────────────────────────
    const olm = line.match(/^(\s*)\d+\.\s+(.+)$/);
    if (olm) {
      closeTable();
      const depth = Math.floor(olm[1].length / 2);
      while (listStack.length > depth + 1) out.push(`</${listStack.pop()}>`);
      if (listStack.length === depth || (listStack.length > 0 && listStack[listStack.length - 1] !== "ol")) {
        if (listStack.length > 0 && listStack[listStack.length - 1] !== "ol") {
          out.push(`</${listStack.pop()}>`);
        }
        out.push('<ol class="md-ol">');
        listStack.push("ol");
      }
      out.push(`<li class="md-li">${inlineFormat(olm[2])}</li>`);
      continue;
    }

    // ── Close open list/table when we hit a blank line ────────────────────────
    if (raw === "") {
      closeList();
      closeTable();
      out.push('<div class="md-spacer"></div>');
      continue;
    }

    // ── Regular paragraph / text ──────────────────────────────────────────────
    closeList();
    closeTable();
    out.push(`<p class="md-p">${inlineFormat(raw)}</p>`);
  }

  closeList();
  closeTable();

  // ── 4. Restore protected blocks ───────────────────────────────────────────
  let html = out.join("\n");
  html = html.replace(/\x00CB(\d+)\x00/g, (_m, i) => codeBlocks[+i]);
  html = html.replace(/\x00IC(\d+)\x00/g, (_m, i) => inlineCodes[+i]);

  return html;
}
