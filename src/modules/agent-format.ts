// Pure string helpers for the agent loop: edit application, line-numbered
// reads, and tool-result compression. No Tauri/DOM imports — unit-testable.

export function applyEdit(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): { content: string; occurrences: number } {
  if (oldString === newString) {
    throw new Error("old_string and new_string are identical — nothing to change.");
  }
  if (!oldString) {
    throw new Error("old_string must not be empty. To create a file, use write_file.");
  }
  const occurrences = content.split(oldString).length - 1;
  if (occurrences === 0) {
    throw new Error(
      "old_string not found in the file. Re-read the file and copy the text exactly — without line-number prefixes — including whitespace.",
    );
  }
  if (occurrences > 1 && !replaceAll) {
    throw new Error(
      `old_string matches ${occurrences} times. Include more surrounding lines to make it unique, or set replace_all to "true".`,
    );
  }
  const updated = replaceAll
    ? content.split(oldString).join(newString)
    : content.replace(oldString, newString);
  return { content: updated, occurrences };
}

export const READ_DEFAULT_LIMIT_LINES = 800;

export function formatLineNumberedRead(content: string, offset = 1, limit = READ_DEFAULT_LIMIT_LINES): string {
  const lines = content.split("\n");
  const total = lines.length;
  const start = Math.min(Math.max(1, Math.floor(offset) || 1), total);
  const count = Math.max(1, Math.floor(limit) || READ_DEFAULT_LIMIT_LINES);
  const end = Math.min(total, start + count - 1);
  const body = lines
    .slice(start - 1, end)
    .map((line, i) => `${String(start + i).padStart(5)}→${line}`)
    .join("\n");
  if (end < total) {
    return `${body}\n…[file continues: ${total} total lines. Call read_file with offset=${end + 1} to continue.]`;
  }
  return body;
}

export function buildEditPreview(updatedContent: string, newString: string, contextLines = 3): string {
  const lines = updatedContent.split("\n");
  let start = 0;
  let end = lines.length;
  if (newString) {
    const idx = updatedContent.indexOf(newString);
    if (idx !== -1) {
      const startLine = updatedContent.slice(0, idx).split("\n").length - 1;
      const newLineCount = newString.split("\n").length;
      start = Math.max(0, startLine - contextLines);
      end = Math.min(lines.length, startLine + newLineCount + contextLines);
    }
  }
  return lines
    .slice(start, end)
    .map((line, i) => `${String(start + i + 1).padStart(5)}→${line}`)
    .join("\n");
}

export function compressToolResult(toolName: string, result: string): string {
  switch (toolName) {
    case "read_file":
    case "batch_read": {
      const CAP = 12000;
      if (result.length <= CAP) return `[${toolName}] ${result}`;
      const lineCount = result.split("\n").length;
      const truncated = result.substring(0, CAP);
      const lastNewline = truncated.lastIndexOf("\n");
      const clean = lastNewline > CAP - 400 ? truncated.substring(0, lastNewline) : truncated;
      const shownLines = clean.split("\n").length;
      return `[${toolName}] ${clean}\n…[truncated: ${lineCount} total lines. Call read_file with offset=${shownLines + 1} for the rest, or search_content for targeted access.]`;
    }

    case "run_command": {
      const CAP = 4000;
      if (result.length <= CAP) return `[${toolName}] ${result}`;
      const head = result.substring(0, 2500);
      const tail = result.substring(result.length - 1500);
      return `[${toolName}] ${head}\n…[${result.length} chars total, showing head+tail]…\n${tail}`;
    }

    case "git_diff": {
      const CAP = 6000;
      if (result.length <= CAP) return `[${toolName}] ${result}`;
      return `[${toolName}] ${result.substring(0, CAP)}\n…[diff truncated: ${result.length} chars total]`;
    }

    case "search_content": {
      const lines = result.split("\n");
      if (lines.length <= 40) return `[${toolName}] ${result}`;
      return `[${toolName}] ${lines.slice(0, 40).join("\n")}\n…[${lines.length - 40} more matches omitted]`;
    }

    case "search_files": {
      const paths = result.split("\n");
      if (paths.length <= 30) return `[${toolName}] ${result}`;
      return `[${toolName}] ${paths.slice(0, 30).join("\n")}\n…[${paths.length - 30} more files omitted]`;
    }

    case "list_dir": {
      const entries = result.split("\n");
      if (entries.length <= 50) return `[${toolName}] ${result}`;
      return `[${toolName}] ${entries.slice(0, 50).join("\n")}\n…[${entries.length - 50} more entries omitted]`;
    }

    case "edit_file":
    case "write_file":
    case "delete_path":
    case "make_plan":
    case "todo_write":
      return `[${toolName}] ${result}`;

    default: {
      const CAP = 3000;
      if (result.length <= CAP) return `[${toolName}] ${result}`;
      return `[${toolName}] ${result.substring(0, CAP)}\n…[truncated]`;
    }
  }
}
