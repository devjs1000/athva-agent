import { invoke } from "@tauri-apps/api/core";
import type { AISettings } from "./settings";
import { addTokens, updateStatusBar } from "./token-usage";

type ReviewTarget = "file" | "changes";
type ReviewSeverity = "high" | "medium" | "low";

interface GitFileChange {
  path: string;
  status: string;
  staged: boolean;
}

interface ReviewSource {
  label: string;
  prompt: string;
}

interface ReviewItem {
  title: string;
  detail: string;
  fileRef?: string;
  recommendation?: string;
  severity?: ReviewSeverity;
  startLine?: number;
  endLine?: number;
}

interface ParsedReview {
  title: string;
  summary: string;
  pros: ReviewItem[];
  cons: ReviewItem[];
}

interface ActiveFileSnapshot {
  path: string;
  content: string;
}

const REVIEW_SYSTEM_PROMPT =
  "You are a senior software engineer doing code review. Return balanced feedback with strengths in pros and bugs, risks, regressions, or missing tests in cons. Be concrete and use file references when possible.";

const DEFAULT_EMPTY_REVIEW: ParsedReview = {
  title: "Review ready",
  summary: "Run a review to see strengths and concerns for the current file or git changes.",
  pros: [],
  cons: [],
};

const STATUS_META: Record<ReviewSeverity, { label: string; className: string }> = {
  high: { label: "High", className: "high" },
  medium: { label: "Medium", className: "medium" },
  low: { label: "Low", className: "low" },
};

export class CodeReviewPanel {
  private panelEl: HTMLElement;
  private resizeEl: HTMLElement;
  private titleEl: HTMLElement;
  private subtitleEl: HTMLElement;
  private statusEl: HTMLElement;
  private contentEl: HTMLElement;
  private fileBtn: HTMLButtonElement;
  private changesBtn: HTMLButtonElement;
  private refreshBtn: HTMLButtonElement;
  private triggerBtn: HTMLButtonElement;
  private closeBtn: HTMLButtonElement;
  private onResize: () => void;
  private getAISettings: () => AISettings;
  private getProjectPath: () => string;
  private getActiveFile: () => ActiveFileSnapshot | null;
  private setEditorContent: (content: string) => void;
  private activeTarget: ReviewTarget = "file";
  private abortController: AbortController | null = null;
  private reviewRunId = 0;
  private lastCons: ReviewItem[] = [];
  private lastConsByFile: Map<string, ReviewItem[]> = new Map();
  private fixInFlight: Set<number> = new Set();

  constructor(
    onResize: () => void,
    getAISettings: () => AISettings,
    getProjectPath: () => string,
    getActiveFile: () => ActiveFileSnapshot | null,
    setEditorContent: (content: string) => void
  ) {
    this.onResize = onResize;
    this.getAISettings = getAISettings;
    this.getProjectPath = getProjectPath;
    this.getActiveFile = getActiveFile;
    this.setEditorContent = setEditorContent;

    this.panelEl = document.getElementById("review-panel")!;
    this.resizeEl = document.getElementById("review-resize")!;
    this.titleEl = document.getElementById("review-title")!;
    this.subtitleEl = document.getElementById("review-subtitle")!;
    this.statusEl = document.getElementById("review-status")!;
    this.contentEl = document.getElementById("review-content")!;
    this.fileBtn = document.getElementById("review-target-file") as HTMLButtonElement;
    this.changesBtn = document.getElementById("review-target-changes") as HTMLButtonElement;
    this.refreshBtn = document.getElementById("btn-review-refresh") as HTMLButtonElement;
    this.triggerBtn = document.getElementById("btn-ai-review") as HTMLButtonElement;
    this.closeBtn = document.getElementById("btn-close-review") as HTMLButtonElement;

    // Target buttons only switch mode — user must click Run Review to execute
    this.fileBtn.addEventListener("click", () => this.setTarget("file"));
    this.changesBtn.addEventListener("click", () => this.setTarget("changes"));
    this.refreshBtn.addEventListener("click", () => void this.runReview(this.activeTarget));
    this.closeBtn.addEventListener("click", () => this.close());

    // Event delegation for run/fix buttons rendered inside contentEl
    this.contentEl.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest("[data-action]") as HTMLElement | null;
      if (!btn) return;
      const action = btn.dataset.action!;
      if (action === "run-review") {
        void this.runReview(this.activeTarget);
      } else if (action === "fix-single") {
        void this.fixSingle(parseInt(btn.dataset.index || "0"), btn);
      } else if (action === "fix-all") {
        void this.fixAll(btn);
      }
    });

    this.renderIdleState();
  }

  open() {
    if (this.panelEl.classList.contains("hidden")) {
      this.panelEl.classList.remove("hidden");
      this.resizeEl.classList.remove("hidden");
      this.triggerBtn.classList.add("active");
      setTimeout(() => this.onResize(), 0);
      this.setTarget(this.pickDefaultTarget());
      this.renderIdleState();
    }
  }

  close() {
    this.abortController?.abort();
    this.abortController = null;
    this.panelEl.classList.add("hidden");
    this.resizeEl.classList.add("hidden");
    this.triggerBtn.classList.remove("active");
    setTimeout(() => this.onResize(), 0);
  }

  async refreshIfOpen() {
    if (this.panelEl.classList.contains("hidden")) return;
    await this.runReview(this.activeTarget);
  }

  private pickDefaultTarget(): ReviewTarget {
    return this.getActiveFile() ? "file" : "changes";
  }

  private setTarget(target: ReviewTarget) {
    this.activeTarget = target;
    this.fileBtn.classList.toggle("active", target === "file");
    this.changesBtn.classList.toggle("active", target === "changes");
  }

  private setBusyState(isBusy: boolean) {
    this.refreshBtn.disabled = isBusy;
    this.fileBtn.disabled = isBusy;
    this.changesBtn.disabled = isBusy;
    this.panelEl.classList.toggle("review-panel-loading", isBusy);
  }

  private renderIdleState() {
    this.titleEl.textContent = "Code Review";
    this.subtitleEl.textContent = "Review the active file or current git changes";
    this.renderStatus("idle", "Ready", "Select a target above, then run the review.");
    this.lastCons = [];
    this.lastConsByFile = new Map();
    this.contentEl.innerHTML = `
      <div class="review-idle-cta">
        <p class="review-idle-hint">Choose <strong>Current File</strong> or <strong>Changes</strong>, then start the review.</p>
        <button class="review-run-btn" data-action="run-review">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M4 2a.5.5 0 0 1 .812-.39l8 5.5a.5.5 0 0 1 0 .78l-8 5.5A.5.5 0 0 1 4 13V2z"/></svg>
          Run Review
        </button>
      </div>
    `;
  }

  private renderStatus(kind: "idle" | "loading" | "success" | "warning" | "error", title: string, text: string) {
    this.statusEl.className = `review-status review-status-${kind}`;
    this.statusEl.innerHTML = `
      <div class="review-status-icon">${this.statusIcon(kind)}</div>
      <div class="review-status-copy">
        <div class="review-status-title">${this.escapeHtml(title)}</div>
        <div class="review-status-text">${this.escapeHtml(text)}</div>
      </div>
    `;
  }

  private renderContent(review: ParsedReview, sourceLabel: string) {
    this.lastCons = review.cons;
    this.lastConsByFile = this.groupByFile(review.cons);

    const prosCount = review.pros.length;
    const consCount = review.cons.length;

    const prosHtml = prosCount > 0
      ? review.pros.map((item) => this.renderItemCard(item, "pro", -1)).join("")
      : `<div class="review-empty-list review-empty-list-pro">
          <div class="review-empty-icon">${this.itemIcon("pro")}</div>
          <div>No standout strengths were extracted from this pass.</div>
        </div>`;

    let consHtml = "";
    if (consCount === 0) {
      consHtml = `<div class="review-empty-list review-empty-list-con">
          <div class="review-empty-icon">${this.itemIcon("con")}</div>
          <div>No critical risks were identified in this pass.</div>
        </div>`;
    } else {
      for (const [file, items] of this.lastConsByFile) {
        const isGeneral = file === "__general__";
        const fileHeader = isGeneral ? "" : `
          <div class="review-file-group-header">
            <span class="review-file-group-name" title="${this.escapeAttr(file)}">${this.escapeHtml(file)}</span>
          </div>`;
        const cards = items.map((item) => this.renderItemCard(item, "con", this.lastCons.indexOf(item))).join("");
        consHtml += `<div class="review-file-group">${fileHeader}${cards}</div>`;
      }
    }

    const fixAllBtn = consCount > 0
      ? `<button class="review-athva-btn review-athva-btn-all" data-action="fix-all">${this.athvaIcon()} Fix all issues</button>`
      : "";

    this.contentEl.innerHTML = `
      <div class="review-overview-card">
        <div class="review-overview-top">
          <div>
            <div class="review-overview-title">${this.escapeHtml(review.title)}</div>
            <div class="review-overview-source">${this.escapeHtml(sourceLabel)}</div>
          </div>
          <div class="review-overview-badges">
            <span class="review-pill review-pill-pro">${this.itemIcon("pro")} ${prosCount} Pros</span>
            <span class="review-pill review-pill-con">${this.itemIcon("con")} ${consCount} Cons</span>
          </div>
        </div>
        <p class="review-summary">${this.escapeHtml(review.summary)}</p>
        ${fixAllBtn}
      </div>

      <section class="review-section review-section-pro">
        <div class="review-section-header">
          <div class="review-section-icon">${this.itemIcon("pro")}</div>
          <div>
            <h3>Pros</h3>
            <p>What looks solid, maintainable, or thoughtfully implemented.</p>
          </div>
        </div>
        <div class="review-card-list">${prosHtml}</div>
      </section>

      <section class="review-section review-section-con">
        <div class="review-section-header">
          <div class="review-section-icon">${this.itemIcon("con")}</div>
          <div>
            <h3>Cons</h3>
            <p>What needs attention before this should be trusted or merged.</p>
          </div>
        </div>
        <div class="review-card-list">${consHtml}</div>
      </section>
    `;
  }

  private groupByFile(items: ReviewItem[]): Map<string, ReviewItem[]> {
    const groups = new Map<string, ReviewItem[]>();
    for (const item of items) {
      const key = item.fileRef?.trim() || "__general__";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(item);
    }
    return groups;
  }

  private renderItemCard(item: ReviewItem, kind: "pro" | "con", conIndex: number): string {
    const severity = kind === "con" ? STATUS_META[item.severity || "medium"] : null;
    const refHtml = item.fileRef
      ? `<div class="review-card-meta">${this.metaIcon()}<span>${this.escapeHtml(item.fileRef)}</span></div>`
      : "";
    const recommendationHtml = item.recommendation
      ? `<div class="review-card-note">${this.escapeHtml(item.recommendation)}</div>`
      : "";
    const hasLines = kind === "con" && conIndex >= 0 && item.startLine && item.endLine;
    const lineLabel = hasLines ? `L${item.startLine}–${item.endLine}` : "";
    const fixBtn = hasLines
      ? `<button class="review-athva-btn review-athva-btn-single" data-action="fix-single" data-index="${conIndex}">${this.athvaIcon()} Fix ${lineLabel}</button>`
      : "";

    return `
      <article class="review-card review-card-${kind}">
        <div class="review-card-head">
          <div class="review-card-title-wrap">
            <div class="review-card-icon">${this.itemIcon(kind)}</div>
            <h4 class="review-card-title">${this.escapeHtml(item.title)}</h4>
          </div>
          ${severity ? `<span class="review-severity review-severity-${severity.className}">${severity.label}</span>` : ""}
        </div>
        <p class="review-card-detail">${this.escapeHtml(item.detail)}</p>
        ${refHtml}
        ${recommendationHtml}
        ${fixBtn}
      </article>
    `;
  }

  private async runReview(target: ReviewTarget) {
    const runId = ++this.reviewRunId;
    this.setTarget(target);

    const settings = this.getAISettings();
    if (!settings.apiKey) {
      this.titleEl.textContent = "Code Review";
      this.subtitleEl.textContent = "No AI provider configured";
      this.renderStatus("warning", "Missing API key", "Add an API key in Settings to use code review.");
      this.renderContent(DEFAULT_EMPTY_REVIEW, "Waiting for configuration");
      return;
    }

    const source = await this.buildSource(target);
    if (runId !== this.reviewRunId) return;
    this.titleEl.textContent = target === "file" ? "Current File Review" : "Changes Review";

    if (!source) return;

    this.subtitleEl.textContent = source.label;
    this.renderStatus("loading", "Running review", "Scanning strengths, risks, and recommendations.");
    this.setBusyState(true);

    this.abortController?.abort();
    this.abortController = new AbortController();

    try {
      const raw = await this.requestReview(settings, source.prompt, this.abortController.signal);
      if (runId !== this.reviewRunId) return;
      const parsed = this.parseReview(raw);
      this.renderStatus(
        parsed.cons.length > 0 ? "warning" : "success",
        parsed.cons.length > 0 ? "Risks identified" : "Clean pass",
        parsed.cons.length > 0
          ? `${parsed.cons.length} concern${parsed.cons.length === 1 ? "" : "s"} surfaced in this review.`
          : "No major risks were identified in this review."
      );
      this.renderContent(parsed, source.label);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return;
      if (runId !== this.reviewRunId) return;
      const message = error instanceof Error ? error.message : String(error);
      this.renderStatus("error", "Review failed", message);
      this.renderContent(
        {
          title: "Review unavailable",
          summary: "The review request did not complete. Fix the provider issue and retry.",
          pros: [],
          cons: [{
            title: "Review request failed",
            detail: message,
            severity: "high",
            recommendation: "Check provider settings and try again.",
          }],
        },
        source.label
      );
    } finally {
      this.setBusyState(false);
    }
  }

  private async buildSource(target: ReviewTarget): Promise<ReviewSource | null> {
    if (target === "file") {
      const file = this.getActiveFile();
      if (!file || !file.content.trim()) {
        this.subtitleEl.textContent = "No file selected";
        this.renderStatus("idle", "Open a file first", "The reviewer can analyze the file currently active in the editor.");
        this.renderContent(DEFAULT_EMPTY_REVIEW, "Waiting for an active file");
        return null;
      }

      const clippedContent = this.clip(file.content, 18000);
      return {
        label: file.path,
        prompt:
          `${this.reviewJsonContract()}\n\n` +
          `Review target: Current file\n` +
          `Path: ${file.path}\n\n` +
          `Code:\n\`\`\`\n${clippedContent}\n\`\`\``,
      };
    }

    const projectPath = this.getProjectPath();
    if (!projectPath) {
      this.subtitleEl.textContent = "No project open";
      this.renderStatus("idle", "Open a project first", "Changes review needs a project so it can inspect git diffs.");
      this.renderContent(DEFAULT_EMPTY_REVIEW, "Waiting for project context");
      return null;
    }

    const files = await invoke<GitFileChange[]>("git_changed_files", { path: projectPath });
    if (files.length === 0) {
      this.subtitleEl.textContent = projectPath;
      this.renderStatus("success", "No changes to review", "Git reports a clean working tree.");
      this.renderContent(
        {
          title: "Working tree is clean",
          summary: "There are no staged or unstaged diffs to send for review.",
          pros: [{
            title: "No pending changes",
            detail: "The repository has no modified tracked files waiting for review.",
          }],
          cons: [],
        },
        projectPath
      );
      return null;
    }

    let diffStat = "";
    try {
      diffStat = await invoke<string>("git_diff_stat", { path: projectPath });
    } catch {
      diffStat = "";
    }

    const diffSections: string[] = [];
    let remaining = 18000;

    for (const file of files) {
      if (remaining <= 0) break;

      const rawDiff = await invoke<string>("git_diff_file", {
        path: projectPath,
        file: file.path,
        staged: file.staged,
      });

      if (!rawDiff.trim()) continue;

      const clipped = rawDiff.length > remaining
        ? `${rawDiff.slice(0, remaining)}\n... [diff truncated]`
        : rawDiff;

      diffSections.push(
        `File: ${file.path}\nState: ${file.staged ? "staged" : "unstaged"} ${file.status}\n\`\`\`diff\n${clipped}\n\`\`\``
      );
      remaining -= clipped.length;
    }

    const summary = files
      .map((file) => `${file.staged ? "[staged]" : "[unstaged]"} ${file.status} ${file.path}`)
      .join("\n");

    return {
      label: `${files.length} changed file${files.length === 1 ? "" : "s"}`,
      prompt:
        `${this.reviewJsonContract()}\n\n` +
        `Review target: Git changes\n` +
        `Project: ${projectPath}\n\n` +
        `Changed files:\n${summary}\n\n` +
        `${diffStat ? `Diff stat:\n${diffStat}\n\n` : ""}` +
        `Diffs${remaining <= 0 ? " (truncated)" : ""}:\n${diffSections.join("\n\n")}`,
    };
  }

  private reviewJsonContract(): string {
    return (
      `${REVIEW_SYSTEM_PROMPT}\n` +
      `Return ONLY valid JSON with this shape:\n` +
      `{"title":"string","summary":"string","pros":[{"title":"string","detail":"string","fileRef":"string"}],"cons":[{"title":"string","detail":"string","fileRef":"string","severity":"high|medium|low","recommendation":"string","startLine":number,"endLine":number}]}\n` +
      `Rules:\n` +
      `- Keep summary to 1-2 sentences.\n` +
      `- Put code quality wins in pros.\n` +
      `- Put bugs, regressions, risky behavior, and missing tests in cons.\n` +
      `- For each con, include startLine and endLine (1-based, inclusive) pointing to the exact lines with the issue.\n` +
      `- Use empty arrays when needed.\n` +
      `- No markdown fences.`
    );
  }

  private async requestReview(settings: AISettings, prompt: string, signal: AbortSignal): Promise<string> {
    const messages = [
      { role: "system", content: REVIEW_SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ];
    const inputChars = messages.reduce((sum, m) => sum + m.content.length, 0);

    let result: string;
    switch (settings.provider) {
      case "openai":
        result = await this.callOpenAICompatible("https://api.openai.com/v1/chat/completions", settings, messages, signal); break;
      case "mimo":
        result = await this.callOpenAICompatible("https://api.xiaomimimo.com/v1/chat/completions", settings, messages, signal); break;
      case "mistral":
        result = await this.callOpenAICompatible("https://api.mistral.ai/v1/chat/completions", settings, messages, signal); break;
      case "anthropic":
        result = await this.callAnthropic(settings, messages, signal); break;
      case "google":
        result = await this.callGoogle(settings, messages, signal); break;
      default:
        throw new Error(`Unknown provider: ${settings.provider}`);
    }
    addTokens(inputChars, result.length);
    updateStatusBar();
    return result;
  }

  private async callOpenAICompatible(
    url: string,
    settings: AISettings,
    messages: { role: string; content: string }[],
    signal: AbortSignal
  ): Promise<string> {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify({
        model: settings.model,
        messages,
        max_tokens: 4096,
        response_format: { type: "json_object" },
      }),
      signal,
    });

    if (!res.ok) {
      throw new Error(await this.describeHttpError(res, "Review API"));
    }

    const data = await res.json();
    return data.choices?.[0]?.message?.content || "";
  }

  private async callAnthropic(
    settings: AISettings,
    messages: { role: string; content: string }[],
    signal: AbortSignal
  ): Promise<string> {
    let system = REVIEW_SYSTEM_PROMPT;
    const bodyMessages = messages
      .filter((message) => {
        if (message.role === "system") {
          system = message.content;
          return false;
        }
        return true;
      })
      .map((message) => ({
        role: message.role === "assistant" ? "assistant" : "user",
        content: message.content,
      }));

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": settings.apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: settings.model,
        system,
        max_tokens: 4096,
        messages: bodyMessages,
      }),
      signal,
    });

    if (!res.ok) {
      throw new Error(await this.describeHttpError(res, "Anthropic review API"));
    }

    const data = await res.json();
    return (data.content || [])
      .filter((part: { type?: string }) => part.type === "text")
      .map((part: { text?: string }) => part.text || "")
      .join("");
  }

  private async callGoogle(
    settings: AISettings,
    messages: { role: string; content: string }[],
    signal: AbortSignal
  ): Promise<string> {
    const prompt = messages.map((message) => `${message.role.toUpperCase()}:\n${message.content}`).join("\n\n");
    const model = settings.model || "gemini-2.0-flash";
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${settings.apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            maxOutputTokens: 4096,
            responseMimeType: "application/json",
          },
        }),
        signal,
      }
    );

    if (!res.ok) {
      throw new Error(await this.describeHttpError(res, "Google review API"));
    }

    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.map((part: { text?: string }) => part.text || "").join("") || "";
  }

  private async describeHttpError(res: Response, label: string): Promise<string> {
    const text = await res.text();
    return `${label} error ${res.status}: ${text || res.statusText}`;
  }

  private parseReview(raw: string): ParsedReview {
    const candidate = this.extractJson(raw);
    if (!candidate) {
      return {
        title: "Review response",
        summary: raw.trim() || "The review model returned no content.",
        pros: [],
        cons: [],
      };
    }

    try {
      const parsed = JSON.parse(candidate) as Partial<ParsedReview>;
      return {
        title: this.cleanText(parsed.title || "") || "Code review",
        summary: this.cleanText(parsed.summary || "") || "Review completed.",
        pros: this.normalizeItems(parsed.pros || [], "pro"),
        cons: this.normalizeItems(parsed.cons || [], "con"),
      };
    } catch {
      return {
        title: "Review response",
        summary: raw.trim() || "The review model returned invalid JSON.",
        pros: [],
        cons: [],
      };
    }
  }

  private normalizeItems(items: unknown[], kind: "pro" | "con"): ReviewItem[] {
    const normalized: ReviewItem[] = [];

    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const value = item as Record<string, unknown>;
      const title = this.cleanText(String(value.title || ""));
      const detail = this.cleanText(String(value.detail || ""));

      if (!title || !detail) continue;

      const severity = typeof value.severity === "string" ? value.severity.toLowerCase() : "medium";
      const startLine = typeof value.startLine === "number" ? value.startLine : undefined;
      const endLine = typeof value.endLine === "number" ? value.endLine : undefined;

      normalized.push({
        title,
        detail,
        fileRef: this.cleanText(String(value.fileRef || "")) || undefined,
        recommendation: this.cleanText(String(value.recommendation || "")) || undefined,
        severity: kind === "con" && ["high", "medium", "low"].includes(severity)
          ? severity as ReviewSeverity
          : kind === "con"
            ? "medium"
            : undefined,
        startLine: startLine && startLine > 0 ? startLine : undefined,
        endLine: endLine && endLine > 0 ? endLine : undefined,
      });
    }

    return normalized;
  }

  private extractJson(raw: string): string | null {
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const text = fenced ? fenced[1] : raw;
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) return null;
    return text.slice(start, end + 1);
  }

  private cleanText(value: string): string {
    return value
      .replace(/\s+/g, " ")
      .replace(/^["'`]+|["'`]+$/g, "")
      .trim();
  }

  private clip(value: string, max: number): string {
    if (value.length <= max) return value;
    return `${value.slice(0, max)}\n... [content truncated]`;
  }

  private itemIcon(kind: "pro" | "con"): string {
    if (kind === "pro") {
      return `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M13.485 1.929a.75.75 0 0 1 .086 1.057l-6.75 7.95a.75.75 0 0 1-1.093.044L2.4 7.65a.75.75 0 1 1 1.06-1.06l2.754 2.753 6.214-7.328a.75.75 0 0 1 1.057-.086z"/></svg>`;
    }

    return `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M7.001 1.566a1.13 1.13 0 0 1 1.998 0l6.364 11.47c.457.823-.091 1.864-.999 1.864H.636c-.908 0-1.456-1.04-.999-1.864L7 1.566zM8 5.25a.75.75 0 0 0-.75.75v3.25a.75.75 0 0 0 1.5 0V6A.75.75 0 0 0 8 5.25zm0 7a1 1 0 1 0 0-2 1 1 0 0 0 0 2z"/></svg>`;
  }

  private statusIcon(kind: "idle" | "loading" | "success" | "warning" | "error"): string {
    if (kind === "loading") {
      return `<span class="review-spinner"></span>`;
    }
    if (kind === "success") {
      return this.itemIcon("pro");
    }
    if (kind === "warning" || kind === "error") {
      return this.itemIcon("con");
    }
    return `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 3a.75.75 0 0 1 .75.75v2.5a.75.75 0 0 1-1.5 0v-2.5A.75.75 0 0 1 8 4zm0 7a1 1 0 1 1 0-2 1 1 0 0 1 0 2z"/></svg>`;
  }

  private metaIcon(): string {
    return `<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M7.5 1.5a.5.5 0 0 1 1 0V3h2.75A1.75 1.75 0 0 1 13 4.75v6.5A1.75 1.75 0 0 1 11.25 13h-6.5A1.75 1.75 0 0 1 3 11.25v-6.5A1.75 1.75 0 0 1 4.75 3H7.5V1.5zm-2.75 3a.75.75 0 0 0-.75.75v6.5c0 .414.336.75.75.75h6.5a.75.75 0 0 0 .75-.75v-6.5a.75.75 0 0 0-.75-.75h-6.5z"/></svg>`;
  }

  private async fixSingle(index: number, btn: HTMLElement) {
    const item = this.lastCons[index];
    if (!item) return;
    if (this.fixInFlight.has(index)) return;
    this.fixInFlight.add(index);

    const file = this.getActiveFile();
    if (!file) { this.fixInFlight.delete(index); return; }

    const origLabel = btn.innerHTML;
    btn.innerHTML = `<span class="review-spinner-sm"></span> Fixing…`;
    btn.classList.add("disabled");

    try {
      const fix = await this.requestFix([item], file.content);
      if (fix !== null) {
        this.setEditorContent(fix);
        btn.innerHTML = `${this.athvaIcon()} Fixed`;
        btn.classList.add("review-athva-btn-done");
      } else {
        btn.innerHTML = origLabel;
        btn.classList.remove("disabled");
      }
    } catch {
      btn.innerHTML = origLabel;
      btn.classList.remove("disabled");
    } finally {
      this.fixInFlight.delete(index);
    }
  }

  private async fixAll(btn: HTMLElement) {
    const fixable = this.lastCons.filter((item) => item.startLine && item.endLine);
    if (!fixable.length) return;

    const file = this.getActiveFile();
    if (!file) return;

    const origLabel = btn.innerHTML;
    btn.innerHTML = `<span class="review-spinner-sm"></span> Fixing all…`;
    btn.classList.add("disabled");

    try {
      const fix = await this.requestFix(fixable, file.content);
      if (fix !== null) {
        this.setEditorContent(fix);
        btn.innerHTML = `${this.athvaIcon()} Fixed all`;
        btn.classList.add("review-athva-btn-done");
        // Mark all individual fix buttons as done
        this.contentEl.querySelectorAll("[data-action='fix-single']").forEach((el) => {
          (el as HTMLElement).innerHTML = `${this.athvaIcon()} Fixed`;
          (el as HTMLElement).classList.add("review-athva-btn-done", "disabled");
        });
      } else {
        btn.innerHTML = origLabel;
        btn.classList.remove("disabled");
      }
    } catch {
      btn.innerHTML = origLabel;
      btn.classList.remove("disabled");
    }
  }

  private async requestFix(items: ReviewItem[], fileContent: string): Promise<string | null> {
    const settings = this.getAISettings();
    if (!settings.apiKey) return null;

    const issueList = items.map((item, i) => {
      let desc = `${i + 1}. ${item.title} (lines ${item.startLine || "?"}–${item.endLine || "?"}): ${item.detail}`;
      if (item.recommendation) desc += `\n   Recommendation: ${item.recommendation}`;
      return desc;
    }).join("\n");

    const systemMsg = "You are a code fixer. You will receive a complete file and a list of issues. Return the COMPLETE fixed file with all issues resolved. Return ONLY the code — no explanation, no markdown fences, no backticks.";
    const userMsg =
      `Issues to fix:\n${issueList}\n\n` +
      `Complete file:\n${fileContent}`;

    try {
      const raw = await this.callFixAPI(settings, systemMsg, userMsg);
      const cleaned = raw.replace(/^```[\w]*\n?/, "").replace(/\n?```\s*$/, "");
      return cleaned || null;
    } catch {
      return null;
    }
  }

  private async callFixAPI(settings: AISettings, system: string, user: string): Promise<string> {
    const signal = new AbortController().signal;
    const inputChars = system.length + user.length;

    let result: string;
    switch (settings.provider) {
      case "openai":
        result = await this.callPlainText("https://api.openai.com/v1/chat/completions", settings, system, user, signal); break;
      case "mimo":
        result = await this.callPlainText("https://api.xiaomimimo.com/v1/chat/completions", settings, system, user, signal); break;
      case "mistral":
        result = await this.callPlainText("https://api.mistral.ai/v1/chat/completions", settings, system, user, signal); break;
      case "anthropic":
        result = await this.callAnthropic(settings, [{ role: "system", content: system }, { role: "user", content: user }], signal); break;
      case "google":
        result = await this.callGoogle(settings, [{ role: "system", content: system }, { role: "user", content: user }], signal); break;
      default:
        throw new Error(`Unknown provider: ${settings.provider}`);
    }
    addTokens(inputChars, result.length);
    updateStatusBar();
    return result;
  }

  /** OpenAI-compatible call WITHOUT response_format: json_object — returns plain text. */
  private async callPlainText(
    url: string,
    settings: AISettings,
    system: string,
    user: string,
    signal: AbortSignal
  ): Promise<string> {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify({
        model: settings.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        max_tokens: 4096,
      }),
      signal,
    });

    if (!res.ok) {
      throw new Error(await this.describeHttpError(res, "Fix API"));
    }

    const data = await res.json();
    return data.choices?.[0]?.message?.content || "";
  }

  private athvaIcon(): string {
    return `<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M7.657 6.247c.11-.33.576-.33.686 0l.645 1.937a2.89 2.89 0 0 0 1.829 1.828l1.936.645c.33.11.33.576 0 .686l-1.937.645a2.89 2.89 0 0 0-1.828 1.829l-.645 1.936a.361.361 0 0 1-.686 0l-.645-1.937a2.89 2.89 0 0 0-1.828-1.828l-1.937-.645a.361.361 0 0 1 0-.686l1.937-.645a2.89 2.89 0 0 0 1.828-1.829l.645-1.936z"/></svg>`;
  }

  private escapeHtml(value: string): string {
    const div = document.createElement("div");
    div.textContent = value;
    return div.innerHTML;
  }

  private escapeAttr(value: string): string {
    return value.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
}
