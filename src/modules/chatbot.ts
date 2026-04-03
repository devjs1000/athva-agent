import type { AISettings } from "./settings";
import {
  type ChatSession,
  createSession,
  saveSession,
  getAllSessions,
  deleteSession,
} from "./chat-store";

export class Chatbot {
  private messagesEl: HTMLElement;
  private inputEl: HTMLTextAreaElement;
  private sendBtn: HTMLElement;
  private sessionListEl: HTMLElement;
  private getAISettings: () => AISettings;

  private session: ChatSession;
  private sessions: ChatSession[] = [];
  private isStreaming = false;

  constructor(
    messagesId: string,
    inputId: string,
    sendBtnId: string,
    sessionListId: string,
    getAISettings: () => AISettings
  ) {
    this.messagesEl = document.getElementById(messagesId)!;
    this.inputEl = document.getElementById(inputId) as HTMLTextAreaElement;
    this.sendBtn = document.getElementById(sendBtnId)!;
    this.sessionListEl = document.getElementById(sessionListId)!;
    this.getAISettings = getAISettings;
    this.session = createSession();

    this.sendBtn.addEventListener("click", () => this.send());
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.send();
      }
    });

    document.getElementById("btn-new-chat")?.addEventListener("click", () => this.newChat());

    this.init();
  }

  private async init() {
    this.sessions = await getAllSessions();
    if (this.sessions.length > 0) {
      this.session = this.sessions[0];
    }
    this.renderSessionList();
    this.renderMessages();
  }

  // ── Sessions ──

  async newChat() {
    // Save current if it has messages
    if (this.session.messages.length > 0) {
      await saveSession(this.session);
    }
    this.session = createSession();
    this.sessions.unshift(this.session);
    this.renderSessionList();
    this.renderMessages();
    this.inputEl.focus();
  }

  private async switchSession(id: string) {
    if (this.isStreaming) return;
    // Save current
    if (this.session.messages.length > 0) {
      await saveSession(this.session);
    }
    const found = this.sessions.find((s) => s.id === id);
    if (found) {
      this.session = found;
      this.renderSessionList();
      this.renderMessages();
    }
  }

  private async removeSession(id: string) {
    if (this.isStreaming) return;
    await deleteSession(id);
    this.sessions = this.sessions.filter((s) => s.id !== id);
    if (this.session.id === id) {
      if (this.sessions.length > 0) {
        this.session = this.sessions[0];
      } else {
        this.session = createSession();
        this.sessions.push(this.session);
      }
    }
    this.renderSessionList();
    this.renderMessages();
  }

  private renderSessionList() {
    this.sessionListEl.innerHTML = this.sessions
      .map(
        (s) => `
      <div class="chat-session-item ${s.id === this.session.id ? "active" : ""}" data-id="${s.id}">
        <span class="chat-session-title">${this.escapeHtml(s.title)}</span>
        <button class="chat-session-delete" data-delete="${s.id}" title="Delete">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z"/></svg>
        </button>
      </div>`
      )
      .join("");

    this.sessionListEl.querySelectorAll(".chat-session-item").forEach((el) => {
      el.addEventListener("click", (e) => {
        if ((e.target as HTMLElement).closest(".chat-session-delete")) return;
        this.switchSession((el as HTMLElement).dataset.id!);
      });
    });

    this.sessionListEl.querySelectorAll(".chat-session-delete").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.removeSession((btn as HTMLElement).dataset.delete!);
      });
    });
  }

  // ── Messages ──

  private renderMessages() {
    this.messagesEl.innerHTML = "";
    if (this.session.messages.length === 0) {
      this.addDOMMessage(
        "assistant",
        "Hello! I'm your AI assistant. Ask me anything about your code or project."
      );
      return;
    }
    for (const msg of this.session.messages) {
      this.addDOMMessage(msg.role, msg.content);
    }
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  private addDOMMessage(role: string, content: string): HTMLElement {
    const div = document.createElement("div");
    div.className = `chat-msg ${role}`;
    div.textContent = content;
    this.messagesEl.appendChild(div);
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    return div;
  }

  // ── Send ──

  private async send() {
    const text = this.inputEl.value.trim();
    if (!text || this.isStreaming) return;

    this.inputEl.value = "";
    this.session.messages.push({ role: "user", content: text });
    this.addDOMMessage("user", text);

    // Auto-title from first user message
    if (this.session.messages.length === 1) {
      this.session.title = text.length > 40 ? text.substring(0, 40) + "..." : text;
      this.renderSessionList();
    }

    const settings = this.getAISettings();
    if (!settings.apiKey) {
      this.addDOMMessage("error", "No API key configured. Go to Settings to add your API key.");
      return;
    }

    // Create streaming message element
    const streamEl = this.addDOMMessage("assistant", "");
    streamEl.classList.add("streaming");

    this.isStreaming = true;
    this.sendBtn.setAttribute("disabled", "true");
    this.sendBtn.textContent = "...";

    try {
      const fullResponse = await this.streamAI(settings, streamEl);
      this.session.messages.push({ role: "assistant", content: fullResponse });
      streamEl.classList.remove("streaming");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      streamEl.className = "chat-msg error";
      streamEl.textContent = `Error: ${msg}`;
      streamEl.classList.remove("streaming");
    } finally {
      this.isStreaming = false;
      this.sendBtn.removeAttribute("disabled");
      this.sendBtn.textContent = "Send";
      this.session.updatedAt = Date.now();
      await saveSession(this.session);
    }
  }

  // ── Streaming API calls ──

  private async streamAI(settings: AISettings, el: HTMLElement): Promise<string> {
    const history = this.session.messages
      .map((m) => ({ role: m.role, content: m.content }));

    switch (settings.provider) {
      case "openai":
        return this.streamOpenAI(settings, history, el);
      case "anthropic":
        return this.streamAnthropic(settings, history, el);
      case "google":
        return this.callGoogleNonStream(settings, history, el);
      case "mimo":
        return this.streamMiMo(settings, history, el);
      case "mistral":
        return this.streamMistral(settings, history, el);
      default:
        throw new Error(`Unknown provider: ${settings.provider}`);
    }
  }

  // ── OpenAI streaming ──
  private async streamOpenAI(
    settings: AISettings,
    messages: { role: string; content: string }[],
    el: HTMLElement
  ): Promise<string> {
    const model = settings.model || "gpt-4o";
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify({ model, messages, stream: true }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`OpenAI API error ${res.status}: ${err}`);
    }

    return this.readSSEStream(res, el, (json) => {
      return json.choices?.[0]?.delta?.content || "";
    });
  }

  // ── Anthropic streaming ──
  private async streamAnthropic(
    settings: AISettings,
    messages: { role: string; content: string }[],
    el: HTMLElement
  ): Promise<string> {
    const model = settings.model || "claude-sonnet-4-20250514";
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": settings.apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({ model, max_tokens: 4096, messages, stream: true }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Anthropic API error ${res.status}: ${err}`);
    }

    return this.readSSEStream(res, el, (json) => {
      if (json.type === "content_block_delta") {
        return json.delta?.text || "";
      }
      return "";
    });
  }

  // ── MiMo streaming (OpenAI-compatible SSE) ──
  private async streamMiMo(
    settings: AISettings,
    messages: { role: string; content: string }[],
    el: HTMLElement
  ): Promise<string> {
    const model = settings.model || "mimo-v2-flash";
    const res = await fetch("https://api.xiaomimimo.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": settings.apiKey,
      },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        temperature: 1.0,
        top_p: 0.95,
        max_completion_tokens: 4096,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`MiMo API error ${res.status}: ${err}`);
    }

    return this.readSSEStream(res, el, (json) => {
      return json.choices?.[0]?.delta?.content || "";
    });
  }

  // ── Mistral streaming (OpenAI-compatible SSE) ──
  private async streamMistral(
    settings: AISettings,
    messages: { role: string; content: string }[],
    el: HTMLElement
  ): Promise<string> {
    const model = settings.model || "mistral-small-latest";
    const res = await fetch("https://api.mistral.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify({ model, messages, max_tokens: 4096, stream: true }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Mistral API error ${res.status}: ${err}`);
    }

    return this.readSSEStream(res, el, (json) => {
      return json.choices?.[0]?.delta?.content || "";
    });
  }

  // ── Google (no SSE, falls back to non-stream with simulated typing) ──
  private async callGoogleNonStream(
    settings: AISettings,
    history: { role: string; content: string }[],
    el: HTMLElement
  ): Promise<string> {
    const model = settings.model || "gemini-2.0-flash";
    const contents = history.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${settings.apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents }),
      }
    );

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Google API error ${res.status}: ${err}`);
    }

    const data = await res.json();
    const fullText = data.candidates?.[0]?.content?.parts?.[0]?.text || "No response.";

    // Simulate streaming for consistent UX
    await this.simulateStream(fullText, el);
    return fullText;
  }

  // ── SSE stream reader (works for OpenAI, Anthropic, MiMo, Mistral) ──
  private async readSSEStream(
    res: Response,
    el: HTMLElement,
    extractContent: (json: any) => string
  ): Promise<string> {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let fullText = "";
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;
        const data = trimmed.slice(6);
        if (data === "[DONE]") continue;

        try {
          const json = JSON.parse(data);
          const chunk = extractContent(json);
          if (chunk) {
            fullText += chunk;
            el.textContent = fullText;
            this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
          }
        } catch {
          // Skip malformed JSON chunks
        }
      }
    }

    return fullText;
  }

  // ── Simulated streaming for non-SSE providers ──
  private simulateStream(text: string, el: HTMLElement): Promise<void> {
    return new Promise((resolve) => {
      let i = 0;
      const step = () => {
        // Write 2-4 chars at a time for speed
        const chunkSize = Math.min(2 + Math.floor(Math.random() * 3), text.length - i);
        i += chunkSize;
        el.textContent = text.substring(0, i);
        this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
        if (i < text.length) {
          requestAnimationFrame(step);
        } else {
          resolve();
        }
      };
      requestAnimationFrame(step);
    });
  }

  private escapeHtml(str: string): string {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }
}
