import type { AISettings } from "./settings";

interface ChatMessage {
  role: "user" | "assistant" | "error";
  content: string;
}

export class Chatbot {
  private messagesEl: HTMLElement;
  private inputEl: HTMLTextAreaElement;
  private sendBtn: HTMLElement;
  private messages: ChatMessage[] = [];
  private getAISettings: () => AISettings;

  constructor(
    messagesId: string,
    inputId: string,
    sendBtnId: string,
    getAISettings: () => AISettings
  ) {
    this.messagesEl = document.getElementById(messagesId)!;
    this.inputEl = document.getElementById(inputId) as HTMLTextAreaElement;
    this.sendBtn = document.getElementById(sendBtnId)!;
    this.getAISettings = getAISettings;

    this.sendBtn.addEventListener("click", () => this.send());
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.send();
      }
    });

    this.renderWelcome();
  }

  private renderWelcome() {
    this.messagesEl.innerHTML = "";
    this.addMessageToDOM("assistant", "Hello! I'm your AI assistant. Ask me anything about your code or project.\n\nMake sure to configure your API key in Settings.");
  }

  private async send() {
    const text = this.inputEl.value.trim();
    if (!text) return;

    this.inputEl.value = "";
    this.addMessage("user", text);

    const settings = this.getAISettings();
    if (!settings.apiKey) {
      this.addMessage("error", "No API key configured. Go to Settings to add your API key.");
      return;
    }

    try {
      this.sendBtn.setAttribute("disabled", "true");
      const response = await this.callAI(settings);
      this.addMessage("assistant", response);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this.addMessage("error", `Error: ${msg}`);
    } finally {
      this.sendBtn.removeAttribute("disabled");
    }
  }

  private async callAI(settings: AISettings): Promise<string> {
    const history = this.messages
      .filter((m) => m.role !== "error")
      .map((m) => ({ role: m.role, content: m.content }));

    if (settings.provider === "openai") {
      return this.callOpenAI(settings, history);
    } else if (settings.provider === "anthropic") {
      return this.callAnthropic(settings, history);
    } else if (settings.provider === "google") {
      return this.callGoogle(settings, history);
    }

    throw new Error(`Unknown provider: ${settings.provider}`);
  }

  private async callOpenAI(
    settings: AISettings,
    messages: { role: string; content: string }[]
  ): Promise<string> {
    const model = settings.model || "gpt-4o";
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify({ model, messages }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`OpenAI API error ${res.status}: ${err}`);
    }

    const data = await res.json();
    return data.choices?.[0]?.message?.content || "No response.";
  }

  private async callAnthropic(
    settings: AISettings,
    messages: { role: string; content: string }[]
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
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        messages,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Anthropic API error ${res.status}: ${err}`);
    }

    const data = await res.json();
    return data.content?.[0]?.text || "No response.";
  }

  private async callGoogle(
    settings: AISettings,
    history: { role: string; content: string }[]
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
    return data.candidates?.[0]?.content?.parts?.[0]?.text || "No response.";
  }

  private addMessage(role: ChatMessage["role"], content: string) {
    if (role !== "error") {
      this.messages.push({ role, content });
    }
    this.addMessageToDOM(role, content);
  }

  private addMessageToDOM(role: string, content: string) {
    const div = document.createElement("div");
    div.className = `chat-msg ${role}`;
    div.textContent = content;
    this.messagesEl.appendChild(div);
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }
}
