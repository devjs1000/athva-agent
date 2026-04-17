
// ── Agent tool definitions for LLM function calling ──

import { MAX_PROJECT_CONTEXT_CHARS, AGENT_TOOLS } from "../config";
import { AgentAccess } from "../modules/settings";

export function capText(value: string, limit: number, suffix = "\n…[truncated]"): string {
    return value.length > limit ? value.substring(0, limit) + suffix : value;
}

export function capProjectContext(projectContext: string): string {
    return capText(projectContext.trim(), MAX_PROJECT_CONTEXT_CHARS, "\n…[project context truncated]");
}

export function buildAgentSystemPrompt(projectPath: string, access: AgentAccess, projectContext = ""): string {
    const tools = AGENT_TOOLS.filter((t) => {
        if (t.name === "read_file" || t.name === "batch_read" || t.name === "list_dir" || t.name === "search_files" || t.name === "search_content") return access.fileRead;
        if (t.name === "write_file" || t.name === "delete_path") return access.fileWrite;
        if (t.name === "run_command") return access.terminal;
        if (t.name === "git_diff") return access.fileRead;
        if (t.name === "make_plan") return true;
        if (t.name === "ask_user") return true;
        return false;
    });

    const toolDescriptions = tools
        .map((t) => `- ${t.name}(${Object.keys(t.parameters).join(", ")}): ${t.description}`)
        .join("\n");

    const contextSection = projectContext
        ? `\n[Project Context]\n${capProjectContext(projectContext)}\n`
        : "";

    //     return `You are Athva Agent. Project: ${projectPath}
    // ${contextSection}
    // Tools: ${toolDescriptions || "(none)"}

    // Format: \`\`\`tool
    // {"tool":"<name>","args":{...}}
    // \`\`\` (one per response, \\n for newlines in strings)

    // Protocol: Plan→Batch→Execute→Output
    // - make_plan FIRST for 2+ step tasks
    // - batch_read for 2+ files, search_content for symbols — avoid full reads
    // - git_diff before reading changed files
    // - ask_user: batch ALL questions in one call via "questions" param
    // - One tool per response. Read before modifying.
    // - Max 5-8 files, ~30KB context. Stop at 80% confidence.
    // - Output: result + minimal explanation + diffs only
    // - Git: ask user first, no git add ., no force push
    // - If exact paths are unknown, discover them first. Never use placeholder paths like {{...}}.
    // - Ask clarifying questions only if the repo/request cannot answer them and the task is genuinely blocked.
    // - run_command over write_file for scaffolding
    // - Skip .env, locks, node_modules, dist, .git
    // - Be concise. No restating requests. No intermediate dumps.
    // - Persist knowledge to \`${projectPath}/.athva/context.md\``;

    const INDENTITY_PROMPT = "your_name:athva"
    const PROJECT_PATH = `project_path:${projectPath}`
    const PROJECT_CONTEXT = `project_context:${projectContext}`
    const TOOLS = `tools:${toolDescriptions}`
    const FORMAT = `format:\`\`\`tool\n{"tool":"<name>","args":{...}}\n\`\`\` (one per response, \\n for newlines in strings)`
    const PROTOCOL = `protocol:Plan→Batch→Execute→Output`
    const RULES = [
        `make_plan FIRST for 2+ step tasks`,
        `batch_read for 2+ files, search_content for symbols — avoid full reads`,
        `git_diff before reading changed files`,
        `ask_user: batch ALL questions in one call via "questions" param`,
        `One tool per response. Read before modifying.`,
        `Max 5-8 files, ~30KB context. Stop at 80% confidence.`,
        `Output: result + minimal explanation + diffs only`,
        `Git: ask user first, no git add ., no force push`,
        `If exact paths are unknown, discover them first. Never use placeholder paths like {{...}}.`,
        `Ask clarifying questions only if the repo/request cannot answer them and the task is genuinely blocked.`,
        `run_command over write_file for scaffolding`,
        `Skip .env, locks, node_modules, dist, .git`,
        `Be concise. No restating requests. No intermediate dumps.`,
    ]

    return `
    ${INDENTITY_PROMPT}
    ${PROJECT_PATH}
    ${PROJECT_CONTEXT}
    ${TOOLS}
    ${FORMAT}
    ${PROTOCOL}
    ${RULES.join("\n")}
    `

}