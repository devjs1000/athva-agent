// ── System prompts ──

export const CHAT_SYSTEM_PROMPT = `You are Athva, a helpful AI coding assistant. You help users understand code, answer programming questions, and provide suggestions. Be concise and precise in your responses.`;

export const MAX_PROJECT_CONTEXT_CHARS = 2200;
export const MAX_COMPACTED_SUMMARY_CHARS = 1800;
export const AGENT_COMPACT_THRESHOLD_TOKENS = 4000;
export const AGENT_KEEP_RECENT_MESSAGES = 4;

// ── Native Tool Definitions (JSON Schema) ──

export interface NativeToolDef {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, { type: string; description: string; enum?: string[]; items?: { type: string } }>;
    required: string[];
  };
}

export const NATIVE_AGENT_TOOLS: NativeToolDef[] = [
  {
    name: "read_file",
    description: "Read the contents of a single file. Use batch_read when you need 2 or more files.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute or project-relative file path to read." },
      },
      required: ["path"],
    },
  },
  {
    name: "batch_read",
    description: "Read 2–8 files at once. Preferred over multiple read_file calls. Pass paths as a JSON array.",
    input_schema: {
      type: "object",
      properties: {
        paths: {
          type: "array",
          description: "Array of file paths to read (2–8 paths).",
          items: { type: "string" },
        },
      },
      required: ["paths"],
    },
  },
  {
    name: "edit_file",
    description:
      "Replace an exact string in an existing file. Preferred over write_file for all changes to existing files. old_string must match the file text exactly (copy it from read_file output WITHOUT the line-number prefixes) and must be unique unless replace_all is \"true\".",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute or project-relative file path." },
        old_string: { type: "string", description: "Exact existing text to replace, without line-number prefixes." },
        new_string: { type: "string", description: "Replacement text." },
        replace_all: { type: "string", description: "Set to \"true\" to replace every occurrence.", enum: ["true", "false"] },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  {
    name: "write_file",
    description: "Create a NEW file, or fully replace one when a rewrite is unavoidable. For changes to existing files use edit_file instead.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute or project-relative file path." },
        content: { type: "string", description: "Full file content to write." },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "delete_path",
    description: "Delete a file or directory. Use with caution.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file or directory to delete." },
      },
      required: ["path"],
    },
  },
  {
    name: "list_dir",
    description: "List the contents of a directory.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path to list." },
      },
      required: ["path"],
    },
  },
  {
    name: "run_command",
    description: "Run a shell command in the project directory. Output is captured and returned.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to execute." },
      },
      required: ["command"],
    },
  },
  {
    name: "search_files",
    description: "Find files by name or path pattern.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Filename or path fragment to search for." },
      },
      required: ["query"],
    },
  },
  {
    name: "search_content",
    description: "Search inside files using a regex pattern. Optionally filter by file glob.",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regex pattern to search for." },
        glob: { type: "string", description: "Optional file glob filter, e.g. '*.ts'." },
      },
      required: ["pattern"],
    },
  },
  {
    name: "git_diff",
    description: "Show git diff for the project or a specific file/branch/commit.",
    input_schema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Optional: file path, branch, or commit to diff against." },
      },
      required: [],
    },
  },
  {
    name: "ask_user",
    description: "Ask the user a question when the task is genuinely ambiguous and cannot be resolved by inspecting the project. Batch all questions into a single call.",
    input_schema: {
      type: "object",
      properties: {
        question: { type: "string", description: "The question to ask the user." },
        type: { type: "string", description: "Input type: 'text', 'select', or 'checkbox'.", enum: ["text", "select", "checkbox"] },
        options: {
          type: "array",
          description: "Options for 'select' or 'checkbox' type.",
          items: { type: "string" },
        },
      },
      required: ["question"],
    },
  },
];

// ── Provider adapters ──

export interface AnthropicToolParam {
  name: string;
  description: string;
  input_schema: NativeToolDef["input_schema"];
}

export interface OpenAIToolParam {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: NativeToolDef["input_schema"];
  };
}

export function toAnthropicTools(tools: NativeToolDef[]): AnthropicToolParam[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));
}

export function toOpenAITools(tools: NativeToolDef[]): OpenAIToolParam[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));
}

export function getToolDefsForAccess(access: { fileRead: boolean; fileWrite: boolean; terminal: boolean }): NativeToolDef[] {
  return NATIVE_AGENT_TOOLS.filter((t) => {
    if (["read_file", "batch_read", "list_dir", "search_files", "search_content", "git_diff"].includes(t.name)) return access.fileRead;
    if (["write_file", "edit_file", "delete_path"].includes(t.name)) return access.fileWrite;
    if (t.name === "run_command") return access.terminal;
    if (t.name === "ask_user") return true;
    return false;
  });
}

// Legacy export for chat-tool-parser fallback (Google/MiMo/Mistral)
export const AGENT_TOOLS = NATIVE_AGENT_TOOLS.map((t) => ({
  name: t.name,
  description: t.description,
  parameters: Object.fromEntries(
    Object.entries(t.input_schema.properties).map(([k, v]) => [k, v.description])
  ),
}));
