// ── System prompts ──

export const CHAT_SYSTEM_PROMPT = `You are Athva, a helpful AI coding assistant. You help users understand code, answer programming questions, and provide suggestions. Be concise and precise in your responses.`;

export const MAX_PROJECT_CONTEXT_CHARS = 2200;
export const MAX_COMPACTED_SUMMARY_CHARS = 1800;
export const AGENT_COMPACT_THRESHOLD_TOKENS = 4000;
export const AGENT_KEEP_RECENT_MESSAGES = 4;

export const AGENT_TOOLS = [
    { name: "read_file", description: "Read a file", parameters: { path: "string" } },
    { name: "batch_read", description: "Read multiple files (2-8). Preferred over read_file.", parameters: { paths: "string — newline-separated paths" } },
    { name: "write_file", description: "Write/create a file", parameters: { path: "string", content: "string" } },
    { name: "delete_path", description: "Delete a file or folder", parameters: { path: "string" } },
    { name: "list_dir", description: "List directory contents", parameters: { path: "string" } },
    { name: "run_command", description: "Run shell command in project dir", parameters: { command: "string" } },
    { name: "search_files", description: "Find files by name/path", parameters: { query: "string" } },
    { name: "search_content", description: "Grep: search inside files", parameters: { pattern: "string — regex", glob: "string — optional file filter e.g. '*.ts'" } },
    { name: "git_diff", description: "Show git diff", parameters: { target: "string — optional file/branch/commit" } },
    { name: "make_plan", description: "Plan before multi-step work (mandatory)", parameters: { title: "string", steps: "string — newline-separated", notes: "string — optional" } },
    {
        name: "ask_user",
        description: "Ask user questions. Batch ALL into one call.",
        parameters: {
            questions: "string — JSON array: [{\"q\":\"text\",\"type\":\"select|checkbox|text\",\"options\":[...]}]",
            question: "string — single question shorthand",
            type: "string — select|checkbox|text",
            options: "string — newline-separated options",
        },
    },
];
