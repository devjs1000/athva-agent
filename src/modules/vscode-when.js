export function matchesVscodeWhenClause(when, context) {
  if (!when || !when.trim()) return true;
  const tokens = tokenizeWhenClause(when);
  let index = 0;

  function parseExpression() {
    let value = parseTerm();
    while (peek(tokens, index) === "||") {
      index += 1;
      const rhs = parseTerm();
      value = value || rhs;
    }
    return value;
  }

  function parseTerm() {
    let value = parseFactor();
    while (peek(tokens, index) === "&&") {
      index += 1;
      const rhs = parseFactor();
      value = value && rhs;
    }
    return value;
  }

  function parseFactor() {
    const token = peek(tokens, index);
    if (token === "!") {
      index += 1;
      return !parseFactor();
    }
    if (token === "(") {
      index += 1;
      const value = parseExpression();
      if (peek(tokens, index) === ")") index += 1;
      return value;
    }
    index += 1;
    return evaluateAtom(token, context);
  }

  return parseExpression();
}

function tokenizeWhenClause(when) {
  const tokens = [];
  const input = String(when).trim();
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === "(" || ch === ")" || ch === "!") {
      tokens.push(ch);
      i += 1;
      continue;
    }
    if (input.startsWith("&&", i) || input.startsWith("||", i)) {
      tokens.push(input.slice(i, i + 2));
      i += 2;
      continue;
    }
    let j = i;
    let quoted = null;
    while (j < input.length) {
      const current = input[j];
      if (!quoted && (current === "(" || current === ")" || current === "!" || input.startsWith("&&", j) || input.startsWith("||", j))) {
        break;
      }
      if (!quoted && (current === "'" || current === '"')) {
        quoted = current;
        j += 1;
        continue;
      }
      if (quoted && current === quoted) {
        quoted = null;
        j += 1;
        continue;
      }
      j += 1;
    }
    tokens.push(input.slice(i, j).trim());
    i = j;
  }
  return tokens.filter(Boolean);
}

function evaluateAtom(atom, context) {
  const trimmed = String(atom ?? "").trim();
  if (!trimmed) return true;
  const eq = trimmed.match(/^([A-Za-z0-9_.-]+)\s*==\s*(.+)$/);
  if (eq) return String(resolveWhenValue(eq[1], context)) === parseWhenValue(eq[2]);
  const neq = trimmed.match(/^([A-Za-z0-9_.-]+)\s*!=\s*(.+)$/);
  if (neq) return String(resolveWhenValue(neq[1], context)) !== parseWhenValue(neq[2]);
  return !!resolveWhenValue(trimmed, context);
}

function resolveWhenValue(key, context) {
  switch (key) {
    case "resourceExtname":
      return context.resourceExtname;
    case "resourceFilename":
      return context.resourceFilename;
    case "resourcePath":
      return context.resourcePath;
    case "resourceScheme":
      return context.resourceScheme;
    case "resourceLangId":
      return context.resourceLangId ?? "";
    case "resourceIsFolder":
    case "explorerResourceIsFolder":
      return context.resourceIsFolder;
    case "resourceIsRoot":
    case "explorerResourceIsRoot":
      return context.resourceIsRoot;
    case "resourceReadonly":
      return context.resourceReadonly ?? false;
    case "isFileSystemResource":
      return context.isFileSystemResource ?? false;
    case "editorFocus":
      return context.editorFocus ?? false;
    case "textInputFocus":
      return context.textInputFocus ?? false;
    case "selectionExists":
      return context.selectionExists ?? false;
    case "view":
      return context.view ?? "";
    case "resource":
      return context.resourcePath;
    default:
      return false;
  }
}

function parseWhenValue(raw) {
  const trimmed = String(raw ?? "").trim();
  if ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function peek(tokens, index) {
  return tokens[index] ?? "";
}
