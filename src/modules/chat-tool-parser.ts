// Tool call parsing logic — extracts tool calls from LLM responses
// Extracted from chatbot.ts for modularity

import type { ToolCall } from "./chat-store";

/**
 * Parse tool calls from an LLM response string.
 * Looks for ```tool blocks and bare JSON objects.
 */
export function parseToolCalls(response: string): { text: string; toolCalls: ToolCall[] } {
  const toolCalls: ToolCall[] = [];
  let text = response;

  // Match ```tool blocks — handle variations: ```tool, ``` tool, with or without closing ```
  const toolBlockRegex = /```\s*tool\s*\n([\s\S]*?)(?:```|$)/g;
  let match: RegExpExecArray | null;

  while ((match = toolBlockRegex.exec(response)) !== null) {
    const block = match[1].trim();
    text = text.replace(match[0], "").trim();

    const extracted = extractToolJsonObjects(block);
    for (const parsed of extracted) {
      if (parsed.tool && parsed.args) {
        toolCalls.push({
          id: crypto.randomUUID(),
          name: parsed.tool,
          args: parsed.args,
          status: "pending",
        });
      }
    }
  }

  // Fallback: also look for bare {"tool": ...} JSON objects outside code blocks
  if (toolCalls.length === 0) {
    const bareJsonRegex = /\{"tool"\s*:\s*"(\w+)"\s*,\s*"args"\s*:\s*(\{[\s\S]*?\})\s*\}/g;
    let bareMatch: RegExpExecArray | null;
    while ((bareMatch = bareJsonRegex.exec(response)) !== null) {
      try {
        const parsed = JSON.parse(bareMatch[0]);
        if (parsed.tool && parsed.args) {
          toolCalls.push({
            id: crypto.randomUUID(),
            name: parsed.tool,
            args: parsed.args,
            status: "pending",
          });
          text = text.replace(bareMatch[0], "").trim();
        }
      } catch {
        // Skip malformed
      }
    }
  }

  return { text, toolCalls };
}

/** Extract valid JSON objects with "tool" and "args" from a block of text */
function extractToolJsonObjects(block: string): { tool: string; args: Record<string, string> }[] {
  const results: { tool: string; args: Record<string, string> }[] = [];

  // Strategy 1: Try each line as a standalone JSON
  for (const line of block.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith("{")) continue;
    const parsed = parseToolJsonCandidate(trimmed);
    if (parsed) {
      results.push(parsed);
    }
  }

  if (results.length > 0) return results;

  // Strategy 2: Try the entire block as one JSON object
  const wholeBlock = parseToolJsonCandidate(block);
  if (wholeBlock) {
    return [wholeBlock];
  }

  // Strategy 3: Find JSON objects by brace matching
  let depth = 0;
  let start = -1;
  for (let i = 0; i < block.length; i++) {
    if (block[i] === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (block[i] === "}") {
      depth--;
      if (depth === 0 && start !== -1) {
        const candidate = block.substring(start, i + 1);
        const parsed = parseToolJsonCandidate(candidate);
        if (parsed) {
          results.push(parsed);
        }
        start = -1;
      }
    }
  }

  return results;
}

function parseToolJsonCandidate(candidate: string): { tool: string; args: Record<string, string> } | null {
  const attempts = [candidate, normalizeJsonLikeToolCall(candidate)];
  for (const attempt of attempts) {
    try {
      const parsed = JSON.parse(attempt);
      if (parsed.tool && parsed.args) {
        return parsed;
      }
    } catch {
      // Try the next normalization
    }
  }
  return null;
}

function normalizeJsonLikeToolCall(text: string): string {
  return text.replace(/\\u\{([0-9a-fA-F]+)\}/g, (_match, hex) => {
    const codePoint = Number.parseInt(hex, 16);
    if (!Number.isFinite(codePoint)) return _match;
    try {
      return String.fromCodePoint(codePoint);
    } catch {
      return _match;
    }
  });
}
