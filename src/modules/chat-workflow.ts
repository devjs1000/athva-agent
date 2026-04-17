export type WorkflowPhase =
  | "discovery"
  | "context_validation"
  | "read"
  | "execution"
  | "verification"
  | "remediation"
  | "complete"
  | "failed";

export type WorkflowStatus =
  | "idle"
  | "running"
  | "awaiting_input"
  | "completed"
  | "failed"
  | "interrupted";

export type WorkflowSnapshotStatus =
  | "running"
  | "done"
  | "awaiting_input"
  | "interrupted"
  | "error"
  | "superseded";

export type WorkflowContextScope = "single_file" | "local_multi_file" | "broad";

export type ExecutorToolName =
  | "read_file"
  | "batch_read"
  | "write_file"
  | "delete_path"
  | "list_dir"
  | "run_command"
  | "search_files"
  | "search_content"
  | "search_in_files"
  | "git_diff";

export interface RetryPolicy {
  max_attempts: number;
  retry_on: string[];
  backoff_ms?: number;
}

export interface PlannerStep {
  id: string;
  title: string;
  description: string;
}

export interface WorkflowPlanAction {
  tool: ExecutorToolName;
  args: Record<string, string>;
  reason: string;
  mutable?: boolean;
}

export interface WorkflowQuestion {
  id: string;
  q: string;
  type: "select" | "checkbox" | "text";
  options?: string[];
  default_answer?: string;
}

export interface ExecutorAction {
  id: string;
  tool: ExecutorToolName;
  args: Record<string, string>;
  mutable: boolean;
  requiresApproval: boolean;
  description: string;
}

export interface ExecutorResult {
  actionId: string;
  tool: ExecutorToolName;
  ok: boolean;
  output: string;
  artifacts: string[];
  durationMs: number;
  args?: Record<string, string>;
  description?: string;
  error?: string;
}

interface BasePlannerPlan {
  kind:
    | "DiscoverySpec"
    | "ContextPlan"
    | "ClarificationPlan"
    | "ReadPlan"
    | "ExecutionPlan"
    | "VerificationPlan"
    | "FixPlan"
    | "FailureReport";
  version: number;
  summary?: string;
  steps?: PlannerStep[];
  tools: ExecutorToolName[];
  expected_output: string;
  timeout_ms: number;
  retry_policy: RetryPolicy;
  raw_response?: string;
}

export interface DiscoverySpec extends BasePlannerPlan {
  kind: "DiscoverySpec";
  scope_hint: WorkflowContextScope;
  targets: string[];
  path_patterns: string[];
  content_patterns: string[];
  actions: WorkflowPlanAction[];
}

export interface ContextPlan extends BasePlannerPlan {
  kind: "ContextPlan";
  scope_hint: WorkflowContextScope;
  sufficiency: "sufficient" | "insufficient";
  missing: string[];
  actions: WorkflowPlanAction[];
}

export interface ClarificationPlan extends BasePlannerPlan {
  kind: "ClarificationPlan";
  questions: WorkflowQuestion[];
  defaults: string[];
}

export interface ReadPlan extends BasePlannerPlan {
  kind: "ReadPlan";
  scope_hint: WorkflowContextScope;
  files: string[];
  symbols: string[];
  actions: WorkflowPlanAction[];
}

export interface ExecutionPlan extends BasePlannerPlan {
  kind: "ExecutionPlan";
  files_to_modify: string[];
  commands: string[];
  actions: WorkflowPlanAction[];
}

export interface VerificationPlan extends BasePlannerPlan {
  kind: "VerificationPlan";
  acceptance_criteria: string[];
  actions: WorkflowPlanAction[];
}

export interface FixPlan extends BasePlannerPlan {
  kind: "FixPlan";
  failure_summary: string;
  actions: WorkflowPlanAction[];
}

export interface FailureReport extends BasePlannerPlan {
  kind: "FailureReport";
  failure_summary: string;
  manual_next_steps: string[];
}

export type PlannerPlan =
  | DiscoverySpec
  | ContextPlan
  | ClarificationPlan
  | ReadPlan
  | ExecutionPlan
  | VerificationPlan
  | FixPlan
  | FailureReport;

export interface WorkflowSnapshot {
  id: string;
  phase: WorkflowPhase;
  iteration: number;
  status: WorkflowSnapshotStatus;
  plan?: PlannerPlan;
  inputs: Record<string, string>;
  tool_results: ExecutorResult[];
  deltas: string[];
  createdAt: number;
  summary: string;
}

export interface WorkflowThresholds {
  minFilesCovered: number;
  maxReadFiles: number;
  maxContextChars: number;
}

export interface WorkflowStateEnvelope {
  runId: string;
  modeVersion: number;
  task: string;
  activePhase: WorkflowPhase;
  retryCount: number;
  snapshots: WorkflowSnapshot[];
  latestSummary: string;
  status: WorkflowStatus;
  thresholds: WorkflowThresholds;
  explicitTargets: string[];
  pendingQuestions?: WorkflowQuestion[];
  pendingPhase?: WorkflowPhase;
  collectedInputs: Record<string, string>;
}

export const WORKFLOW_MODE_VERSION = 1;
export const WORKFLOW_MAX_RETRIES = 3;
export const WORKFLOW_MAX_ITERATIONS = 18;
export const PROJECT_ROOT_TOKEN = "__PROJECT_ROOT__";

export const WORKFLOW_THRESHOLDS: Record<WorkflowContextScope, WorkflowThresholds> = {
  single_file: { minFilesCovered: 1, maxReadFiles: 3, maxContextChars: 12000 },
  local_multi_file: { minFilesCovered: 3, maxReadFiles: 6, maxContextChars: 18000 },
  broad: { minFilesCovered: 5, maxReadFiles: 8, maxContextChars: 24000 },
};

function phaseDisplay(phase: WorkflowPhase): string {
  switch (phase) {
    case "context_validation":
      return "Context Validation";
    default:
      return phase.charAt(0).toUpperCase() + phase.slice(1);
  }
}

export function workflowPhaseLabel(phase: WorkflowPhase): string {
  return phaseDisplay(phase);
}

function clip(value: string, limit: number): string {
  return value.length > limit ? value.slice(0, limit) + "…" : value;
}

function singleLine(value: string, limit: number): string {
  return clip(value.replace(/\s+/g, " ").trim(), limit);
}

export function extractExplicitTargets(task: string): string[] {
  const targets = new Set<string>();
  const shouldKeep = (value: string) => {
    const normalized = value.trim();
    if (!normalized) return false;
    if (/node_modules[\\/]/i.test(normalized)) return false;
    if (/^(node:|internal[\\/])/i.test(normalized)) return false;
    return true;
  };

  for (const match of task.matchAll(/`([^`]+)`/g)) {
    const value = match[1].trim();
    if (shouldKeep(value)) targets.add(value);
  }

  for (const match of task.matchAll(/\b[\w./-]+\.[A-Za-z0-9]+\b/g)) {
    if (shouldKeep(match[0])) targets.add(match[0]);
  }

  return Array.from(targets).slice(0, 12);
}

export function deriveInitialScope(task: string, explicitTargets: string[]): WorkflowContextScope {
  if (explicitTargets.length <= 1 && /file|function|component|class|module/i.test(task)) {
    return "single_file";
  }
  if (explicitTargets.length >= 3 || /codebase|entire|across|multiple/i.test(task)) {
    return "broad";
  }
  return "local_multi_file";
}

export function createWorkflowState(task: string): WorkflowStateEnvelope {
  const explicitTargets = extractExplicitTargets(task);
  const scope = deriveInitialScope(task, explicitTargets);
  return {
    runId: crypto.randomUUID(),
    modeVersion: WORKFLOW_MODE_VERSION,
    task,
    activePhase: "discovery",
    retryCount: 0,
    snapshots: [],
    latestSummary: "",
    status: "idle",
    thresholds: WORKFLOW_THRESHOLDS[scope],
    explicitTargets,
    collectedInputs: {},
  };
}

export function createWorkflowSnapshot(
  phase: WorkflowPhase,
  iteration: number,
  status: WorkflowSnapshotStatus,
  summary: string,
  overrides: Partial<Omit<WorkflowSnapshot, "id" | "phase" | "iteration" | "status" | "summary" | "createdAt">> = {},
): WorkflowSnapshot {
  return {
    id: crypto.randomUUID(),
    phase,
    iteration,
    status,
    summary,
    createdAt: Date.now(),
    inputs: {},
    tool_results: [],
    deltas: [],
    ...overrides,
  };
}

export function appendWorkflowSnapshot(
  state: WorkflowStateEnvelope,
  snapshot: WorkflowSnapshot,
): WorkflowStateEnvelope {
  return {
    ...state,
    snapshots: [...state.snapshots, snapshot],
    latestSummary: snapshot.summary || state.latestSummary,
  };
}

export function summarizeWorkflowState(state: WorkflowStateEnvelope): string {
  const latest = state.snapshots[state.snapshots.length - 1];
  const parts = [
    `status=${state.status}`,
    `phase=${state.activePhase}`,
    `retryCount=${state.retryCount}`,
    `snapshots=${state.snapshots.length}`,
  ];
  if (state.explicitTargets.length > 0) {
    parts.push(`explicitTargets=${state.explicitTargets.join(", ")}`);
  }
  if (state.latestSummary) {
    parts.push(`latest=${state.latestSummary}`);
  }
  if (latest?.deltas?.length) {
    parts.push(`deltas=${latest.deltas.slice(-3).join(" | ")}`);
  }
  return parts.join("\n");
}

export function workflowSnapshotCardLines(snapshot: WorkflowSnapshot): string[] {
  const lines = [`${workflowPhaseLabel(snapshot.phase)} · ${snapshot.status}`];
  if (snapshot.tool_results.length) {
    const ok = snapshot.tool_results.filter((r) => r.ok).length;
    lines.push(`${ok}/${snapshot.tool_results.length} actions succeeded`);
  }
  if (snapshot.deltas.length) {
    lines.push(snapshot.deltas.join(" | "));
  }
  return lines.filter(Boolean);
}

export function plannerPlanToActions(plan: PlannerPlan): WorkflowPlanAction[] {
  if ("actions" in plan && Array.isArray(plan.actions)) {
    const normalized = plan.actions.filter((action) => action && action.tool);
    if (normalized.length > 0) return normalized;
  }
  return deriveFallbackActions(plan);
}

export function toExecutorAction(action: WorkflowPlanAction): ExecutorAction {
  const mutable = Boolean(action.mutable) || action.tool === "write_file" || action.tool === "delete_path" || action.tool === "run_command";
  return {
    id: crypto.randomUUID(),
    tool: action.tool,
    args: action.args || {},
    mutable,
    requiresApproval: mutable,
    description: action.reason || `${action.tool} action`,
  };
}

function uniqueActions(actions: WorkflowPlanAction[]): WorkflowPlanAction[] {
  const seen = new Set<string>();
  const result: WorkflowPlanAction[] = [];
  for (const action of actions) {
    const key = `${action.tool}:${JSON.stringify(action.args)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(action);
  }
  return result;
}

function basenameQuery(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || trimmed;
}

function deriveDiscoveryActions(plan: DiscoverySpec): WorkflowPlanAction[] {
  const queries = new Set<string>(["package.json", "app.js", "server.js", "index.js"]);
  const contentPatterns = new Set<string>(["express"]);

  for (const target of plan.targets || []) {
    const query = basenameQuery(target);
    if (query) queries.add(query);
  }
  for (const pattern of plan.path_patterns || []) {
    const query = basenameQuery(pattern.replace(/\*/g, ""));
    if (query) queries.add(query);
  }
  for (const pattern of plan.content_patterns || []) {
    const query = pattern.trim();
    if (query) contentPatterns.add(query);
  }

  const actions: WorkflowPlanAction[] = [
    {
      tool: "list_dir",
      args: { path: PROJECT_ROOT_TOKEN },
      reason: "List the project root once before deeper inspection.",
    },
  ];

  for (const query of Array.from(queries).slice(0, 6)) {
    actions.push({
      tool: "search_files",
      args: { query },
      reason: `Search for ${query} across the project.`,
    });
  }

  for (const pattern of Array.from(contentPatterns).slice(0, 4)) {
    actions.push({
      tool: "search_in_files",
      args: { query: pattern, max_results: "25" },
      reason: `Search file contents for ${pattern}.`,
    });
  }

  return uniqueActions(actions);
}

function deriveReadActions(plan: ReadPlan): WorkflowPlanAction[] {
  const files = Array.from(new Set((plan.files || []).filter(Boolean))).slice(0, 8);
  const actions: WorkflowPlanAction[] = [];

  if (files.length > 0) {
    actions.push({
      tool: "batch_read",
      args: { paths: files.join("\n") },
      reason: "Batch-read the relevant files gathered during discovery.",
    });
  }

  for (const symbol of (plan.symbols || []).slice(0, 3)) {
    actions.push({
      tool: "search_in_files",
      args: { query: symbol, max_results: "20" },
      reason: `Search for symbol or keyword ${symbol}.`,
    });
  }

  return uniqueActions(actions);
}

function deriveExecutionActions(plan: ExecutionPlan): WorkflowPlanAction[] {
  const actions: WorkflowPlanAction[] = [];

  for (const command of (plan.commands || []).slice(0, 4)) {
    actions.push({
      tool: "run_command",
      args: { command },
      reason: `Run execution command: ${command}`,
      mutable: true,
    });
  }

  return uniqueActions(actions);
}

function deriveVerificationActions(plan: VerificationPlan): WorkflowPlanAction[] {
  const actions: WorkflowPlanAction[] = [];
  const combined = [
    ...(plan.acceptance_criteria || []),
    ...(plan.steps || []).map((step) => step.description),
  ].join("\n");

  const commandMatches = Array.from(combined.matchAll(/`([^`]+)`/g)).map((match) => match[1].trim());
  for (const command of commandMatches.slice(0, 4)) {
    actions.push({
      tool: "run_command",
      args: { command },
      reason: `Run verification command: ${command}`,
      mutable: true,
    });
  }

  return uniqueActions(actions);
}

function deriveFixActions(plan: FixPlan): WorkflowPlanAction[] {
  const inlineCommands = Array.from(plan.failure_summary.matchAll(/`([^`]+)`/g)).map((match) => match[1].trim());
  return uniqueActions(
    inlineCommands.slice(0, 3).map((command) => ({
      tool: "run_command" as const,
      args: { command },
      reason: `Run remediation command: ${command}`,
      mutable: true,
    })),
  );
}

function deriveFallbackActions(plan: PlannerPlan): WorkflowPlanAction[] {
  switch (plan.kind) {
    case "DiscoverySpec":
      return deriveDiscoveryActions(plan);
    case "ReadPlan":
      return deriveReadActions(plan);
    case "ExecutionPlan":
      return deriveExecutionActions(plan);
    case "VerificationPlan":
      return deriveVerificationActions(plan);
    case "FixPlan":
      return deriveFixActions(plan);
    default:
      return [];
  }
}

function sanitizeStep(raw: any, index: number): PlannerStep {
  return {
    id: String(raw?.id || `step_${index + 1}`),
    title: String(raw?.title || `Step ${index + 1}`),
    description: String(raw?.description || ""),
  };
}

function sanitizeAction(raw: any): WorkflowPlanAction | null {
  if (!raw || typeof raw !== "object") return null;
  const tool = String(raw.tool || "").trim() as ExecutorToolName;
  if (!tool) return null;
  const rawArgs =
    raw.args && typeof raw.args === "object"
      ? Object.fromEntries(
          Object.entries(raw.args as Record<string, unknown>).map(([key, value]) => [key, String(value ?? "")]),
        )
      : {};
  const args = normalizeActionArgs(tool, rawArgs);
  return {
    tool,
    args,
    reason: String(raw.reason || ""),
    mutable: Boolean(raw.mutable),
  };
}

function firstPresent(args: Record<string, string>, keys: string[]): string {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

function normalizeLooseArgValue(value: string): string {
  let cleaned = String(value || "").trim();
  cleaned = cleaned.replace(/^["'`]+|["'`,]+$/g, "");
  cleaned = cleaned.replace(/^["'`]*[a-z_][a-z0-9_-]{1,}["'`]*\s*:\s*/i, "");
  cleaned = cleaned.replace(/^["'`]+|["'`,]+$/g, "");
  return cleaned.trim();
}

function normalizePathArgValue(value: string): string {
  return normalizeLooseArgValue(value);
}

function normalizeActionArgs(tool: ExecutorToolName, args: Record<string, string>): Record<string, string> {
  const normalized = { ...args };

  if (tool === "write_file") {
    const path = firstPresent(args, ["path", "file_path", "filepath", "file", "target_path", "target", "location"]);
    const content = firstPresent(args, ["content", "contents", "body", "text", "source"]);
    if (path) normalized.path = normalizePathArgValue(path);
    if (content) normalized.content = content;
  }

  if (tool === "delete_path") {
    const path = firstPresent(args, ["path", "file_path", "filepath", "file", "target_path", "target", "location"]);
    if (path) normalized.path = normalizePathArgValue(path);
  }

  if (tool === "run_command") {
    const command = firstPresent(args, ["command", "cmd", "script"]);
    if (command) normalized.command = command;
  }

  if (tool === "search_files") {
    const query = firstPresent(args, ["query", "pattern", "name", "filename", "file", "path", "target"]);
    if (query) normalized.query = query;
  }

  if (tool === "search_in_files" || tool === "search_content") {
    const query = firstPresent(args, ["query", "pattern", "text", "needle", "symbol"]);
    if (query) normalized.query = query;
    if (tool === "search_content" && query) normalized.pattern = normalized.pattern || query;
  }

  if (tool === "batch_read") {
    const paths = firstPresent(args, ["paths", "files", "file_paths", "filepaths"]);
    if (paths) {
      normalized.paths = paths
        .split("\n")
        .map((part) => normalizePathArgValue(part))
        .filter(Boolean)
        .join("\n");
    }
  }

  if (tool === "read_file" || tool === "list_dir") {
    const path = firstPresent(args, ["path", "file_path", "filepath", "file", "target_path", "target"]);
    if (path) normalized.path = normalizePathArgValue(path);
  }

  return normalized;
}

function sanitizeQuestion(raw: any, index: number): WorkflowQuestion {
  const type = String(raw?.type || "text").toLowerCase();
  const questionType = type === "select" || type === "checkbox" ? type : "text";
  return {
    id: String(raw?.id || `q_${index + 1}`),
    q: String(raw?.q || raw?.question || `Question ${index + 1}`),
    type: questionType,
    options: Array.isArray(raw?.options) ? raw.options.map(String) : undefined,
    default_answer: raw?.default_answer ? String(raw.default_answer) : undefined,
  };
}

function defaultRetryPolicy(): RetryPolicy {
  return {
    max_attempts: WORKFLOW_MAX_RETRIES,
    retry_on: ["planner_error", "verification_failure"],
    backoff_ms: 0,
  };
}

function normalizeExpectedOutput(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function extractActions(raw: any): WorkflowPlanAction[] {
  const direct = Array.isArray(raw?.actions) ? raw.actions : [];
  const misplacedTools = Array.isArray(raw?.tools)
    ? raw.tools.filter((entry: any) => entry && typeof entry === "object" && typeof entry.tool === "string")
    : [];
  const source = direct.length > 0 ? direct : misplacedTools;
  return source.map(sanitizeAction).filter(Boolean) as WorkflowPlanAction[];
}

function extractToolNames(raw: any, actions: WorkflowPlanAction[]): ExecutorToolName[] {
  const explicitNames = Array.isArray(raw?.tools)
    ? raw.tools
        .filter((entry: unknown) => typeof entry === "string")
        .map((entry: unknown) => String(entry) as ExecutorToolName)
    : [];
  if (explicitNames.length > 0) return explicitNames;
  return Array.from(new Set(actions.map((action) => action.tool)));
}

function normalizeBase<T extends BasePlannerPlan>(raw: any): T {
  const actions = extractActions(raw);
  return {
    ...raw,
    version: Number(raw?.version || WORKFLOW_MODE_VERSION),
    summary: typeof raw?.summary === "string" ? raw.summary : undefined,
    steps: Array.isArray(raw?.steps) ? raw.steps.map(sanitizeStep) : [],
    tools: extractToolNames(raw, actions),
    expected_output: normalizeExpectedOutput(raw?.expected_output),
    timeout_ms: Number(raw?.timeout_ms || 30000),
    raw_response: typeof raw?.raw_response === "string" ? raw.raw_response : undefined,
    retry_policy: raw?.retry_policy && typeof raw.retry_policy === "object"
      ? {
          max_attempts: Number(raw.retry_policy.max_attempts || raw.retry_policy.max_retries || WORKFLOW_MAX_RETRIES),
          retry_on: Array.isArray(raw.retry_policy.retry_on) ? raw.retry_policy.retry_on.map(String) : defaultRetryPolicy().retry_on,
          backoff_ms: Number(raw.retry_policy.backoff_ms || 0),
        }
      : defaultRetryPolicy(),
  };
}

function parseJsonObject(raw: string): any | null {
  const fenced = raw.match(/```json\s*([\s\S]*?)```/i) || raw.match(/```[\s\S]*?\n([\s\S]*?)```/i);
  const candidate = fenced?.[1] || raw.match(/\{[\s\S]*\}/)?.[0];
  if (!candidate) return null;
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

export function parsePlannerPlan(raw: string): PlannerPlan | null {
  const parsed = parseJsonObject(raw);
  if (!parsed || typeof parsed !== "object") return null;
  parsed.raw_response = raw.length > 2500 ? raw.slice(0, 2500) + "…" : raw;
  const kind = String(parsed.kind || "").trim();
  const actions = extractActions(parsed);

  switch (kind) {
    case "DiscoverySpec":
      return {
        ...normalizeBase<DiscoverySpec>(parsed),
        kind,
        scope_hint: (parsed.scope_hint as WorkflowContextScope) || "local_multi_file",
        targets: Array.isArray(parsed.targets) ? parsed.targets.map(String) : [],
        path_patterns: Array.isArray(parsed.path_patterns) ? parsed.path_patterns.map(String) : [],
        content_patterns: Array.isArray(parsed.content_patterns) ? parsed.content_patterns.map(String) : [],
        actions,
      };
    case "ContextPlan":
      return {
        ...normalizeBase<ContextPlan>(parsed),
        kind,
        scope_hint: (parsed.scope_hint as WorkflowContextScope) || "local_multi_file",
        sufficiency: parsed.sufficiency === "sufficient" ? "sufficient" : "insufficient",
        missing: Array.isArray(parsed.missing) ? parsed.missing.map(String) : [],
        actions,
      };
    case "ClarificationPlan":
      return {
        ...normalizeBase<ClarificationPlan>(parsed),
        kind,
        questions: Array.isArray(parsed.questions) ? parsed.questions.map(sanitizeQuestion) : [],
        defaults: Array.isArray(parsed.defaults) ? parsed.defaults.map(String) : [],
      };
    case "ReadPlan":
      return {
        ...normalizeBase<ReadPlan>(parsed),
        kind,
        scope_hint: (parsed.scope_hint as WorkflowContextScope) || "local_multi_file",
        files: Array.isArray(parsed.files) ? parsed.files.map(String) : [],
        symbols: Array.isArray(parsed.symbols) ? parsed.symbols.map(String) : [],
        actions,
      };
    case "ExecutionPlan":
      return {
        ...normalizeBase<ExecutionPlan>(parsed),
        kind,
        files_to_modify: Array.isArray(parsed.files_to_modify) ? parsed.files_to_modify.map(String) : [],
        commands: Array.isArray(parsed.commands) ? parsed.commands.map(String) : [],
        actions,
      };
    case "VerificationPlan":
      return {
        ...normalizeBase<VerificationPlan>(parsed),
        kind,
        acceptance_criteria: Array.isArray(parsed.acceptance_criteria) ? parsed.acceptance_criteria.map(String) : [],
        actions,
      };
    case "FixPlan":
      return {
        ...normalizeBase<FixPlan>(parsed),
        kind,
        failure_summary: String(parsed.failure_summary || ""),
        actions,
      };
    case "FailureReport":
      return {
        ...normalizeBase<FailureReport>(parsed),
        kind,
        failure_summary: String(parsed.failure_summary || ""),
        manual_next_steps: Array.isArray(parsed.manual_next_steps) ? parsed.manual_next_steps.map(String) : [],
      };
    default:
      return null;
  }
}

export function buildWorkflowPlannerPrompt(args: {
  phase: WorkflowPhase;
  task: string;
  projectContext: string;
  workflowState: WorkflowStateEnvelope;
  latestResults: ExecutorResult[];
  latestInputs: Record<string, string>;
  latestUserMessage: string;
}): string {
  const latestResultsText = args.latestResults.length === 0
    ? "(none)"
    : args.latestResults
        .slice(-4)
        .map((result) => {
          const artifacts = result.artifacts.slice(0, 3).join(", ") || "-";
          const output = singleLine(result.output || result.error || "", 180);
          const command = result.args?.command ? ` cmd=${singleLine(result.args.command, 120)}` : "";
          const path = result.args?.path ? ` path=${singleLine(result.args.path, 120)}` : "";
          return `${result.tool} ok=${result.ok}${command}${path} art=${artifacts} out=${output || "-"}`;
        })
        .join("\n");

  const latestInputsText = Object.keys(args.latestInputs).length === 0
    ? "(none)"
    : clip(JSON.stringify(args.latestInputs), 300);

  const collectedInputsText = Object.keys(args.workflowState.collectedInputs).length === 0
    ? "(none)"
    : clip(JSON.stringify(args.workflowState.collectedInputs), 300);

  const projectContextText = args.projectContext
    ? clip(args.projectContext.trim(), 500)
    : "(none)";

  const taskText = clip(args.task.trim(), 300);
  const latestUserText = clip(args.latestUserMessage.trim(), 220);
  const summaryText = clip(summarizeWorkflowState(args.workflowState), 500);

  return [
    "Athva workflow planner. Return one JSON object only.",
    `phase=${args.phase}`,
    "App executes tools; you only plan.",
    "Discovery/context/read are app-driven before execution.",
    "Kinds: DiscoverySpec|ContextPlan|ClarificationPlan|ReadPlan|ExecutionPlan|VerificationPlan|FixPlan|FailureReport.",
    "Required keys: kind, version, tools, expected_output, timeout_ms, retry_policy.",
    "Use actions with concrete tool calls. For execution/verification/fix, never return empty actions.",
    "Use only: batch_read, read_file, write_file, delete_path, run_command, search_files, search_in_files, list_dir, git_diff.",
    "Use existing files and existing package scripts only. Do not invent lint/test scripts or placeholder template values.",
    "search_files is recursive across nested project folders and already skips node_modules/.git/dist/build noise.",
    "Use search_files/search_in_files to locate exact nested files or references before planning edits or deletions.",
    "Avoid long-running verification commands like starting dev servers; prefer terminating checks that exit on their own.",
    "In verification/remediation, do not invent ad-hoc npx/npm exec commands. Prefer read_file/search/list_dir or commands already proven to work in earlier results.",
    "Omit summary and steps unless they add necessary value. Do not pad the response with generic plan steps.",
    "Use ClarificationPlan only when missing information truly blocks a safe action and the answer cannot be discovered from the repo.",
    "ClarificationPlan must include 1-3 concrete questions. If you have no concrete question, return FailureReport instead.",
    "For cleanup or file-removal tasks, use delete_path only with exact paths already discovered in prior results. Do not invent placeholders like {{...}}.",
    "If missing info: ClarificationPlan. If no safe path: FailureReport.",
    "",
    `[task]\n${taskText || "(none)"}`,
    "",
    `[latest_user]\n${latestUserText || "(none)"}`,
    "",
    `[targets]\n${args.workflowState.explicitTargets.join(", ") || "(none)"}`,
    "",
    `[thresholds]\n${JSON.stringify(args.workflowState.thresholds)}`,
    "",
    `[inputs]\nlatest=${latestInputsText}\nall=${collectedInputsText}`,
    "",
    `[state]\n${summaryText}`,
    "",
    `[results]\n${latestResultsText}`,
    "",
    `[project_context]\n${projectContextText}`,
    "",
    "[schema]",
    'actions=[{tool,args,reason,mutable}]',
    'questions=[{id,q,type,options?,default_answer?}]',
  ].join("\n");
}
