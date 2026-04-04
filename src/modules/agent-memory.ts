import { invoke } from "@tauri-apps/api/core";
import type { AISettings } from "./settings";

export interface MemoryEntry {
  id: number;
  content: string;
  memory_type: string;
  project_path: string | null;
  tags: string;
  created_at: number;
  score: number;
}

export interface MemoryStats {
  global_count: number;
  project_count: number;
}

export class AgentMemory {
  constructor(
    private getAISettings: () => AISettings,
    private getProjectPath: () => string
  ) {}

  async init(): Promise<void> {
    await invoke("memory_init");
  }

  async embed(text: string): Promise<number[]> {
    const settings = this.getAISettings();
    if (!settings.apiKey) return [];

    try {
      switch (settings.provider) {
        case "openai":
        case "mimo":
        case "mistral": {
          const urls: Record<string, string> = {
            openai: "https://api.openai.com/v1/embeddings",
            mimo: "https://api.xiaomimimo.com/v1/embeddings",
            mistral: "https://api.mistral.ai/v1/embeddings",
          };
          const model =
            settings.provider === "openai" ? "text-embedding-3-small" : settings.model;
          const res = await fetch(urls[settings.provider], {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${settings.apiKey}`,
            },
            body: JSON.stringify({ model, input: text }),
          });
          if (!res.ok) return [];
          const data = await res.json();
          return data.data?.[0]?.embedding ?? [];
        }

        case "anthropic": {
          // Anthropic doesn't have an embeddings endpoint — fall back to empty
          return [];
        }

        case "google": {
          const model = "text-embedding-004";
          const res = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent?key=${settings.apiKey}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ content: { parts: [{ text }] } }),
            }
          );
          if (!res.ok) return [];
          const data = await res.json();
          return data.embedding?.values ?? [];
        }

        default:
          return [];
      }
    } catch {
      return [];
    }
  }

  async add(content: string, type: "global" | "project", tags = ""): Promise<void> {
    const embedding = await this.embed(content);
    const projectPath = type === "project" ? this.getProjectPath() || null : null;
    await invoke("memory_add", {
      content,
      embedding,
      memoryType: type,
      projectPath,
      tags,
    });
  }

  async search(query: string, limit = 5): Promise<MemoryEntry[]> {
    const embedding = await this.embed(query);
    if (embedding.length === 0) return [];
    return invoke<MemoryEntry[]>("memory_search", {
      queryEmbedding: embedding,
      memoryType: "all",
      projectPath: this.getProjectPath() || null,
      limit,
    });
  }

  async list(type: "global" | "project"): Promise<MemoryEntry[]> {
    const projectPath = type === "project" ? this.getProjectPath() || null : null;
    return invoke<MemoryEntry[]>("memory_list", {
      memoryType: type,
      projectPath,
    });
  }

  async delete(id: number): Promise<void> {
    await invoke("memory_delete", { id });
  }

  async clear(type: "global" | "project"): Promise<void> {
    const projectPath = type === "project" ? this.getProjectPath() || null : null;
    await invoke("memory_clear", { memoryType: type, projectPath });
  }

  async stats(): Promise<MemoryStats> {
    return invoke<MemoryStats>("memory_stats", {
      projectPath: this.getProjectPath() || null,
    });
  }
}
