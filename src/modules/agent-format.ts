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
