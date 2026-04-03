// Per-provider model lists for AI chat

export interface ModelOption {
  id: string;
  label: string;
}

export const PROVIDER_MODELS: Record<string, ModelOption[]> = {
  openai: [
    // GPT-4.1
    { id: "gpt-4.1", label: "GPT-4.1 (1M context)" },
    { id: "gpt-4.1-mini", label: "GPT-4.1 Mini" },
    { id: "gpt-4.1-nano", label: "GPT-4.1 Nano" },
    // GPT-4o
    { id: "gpt-4o", label: "GPT-4o" },
    { id: "gpt-4o-mini", label: "GPT-4o Mini" },
    // GPT-4
    { id: "gpt-4-turbo", label: "GPT-4 Turbo" },
    { id: "gpt-4", label: "GPT-4" },
    // o-series reasoning
    { id: "o4-mini", label: "o4 Mini (reasoning)" },
    { id: "o3", label: "o3 (reasoning)" },
    { id: "o3-mini", label: "o3 Mini (reasoning)" },
    { id: "o3-pro", label: "o3 Pro (extra compute)" },
    { id: "o1", label: "o1" },
    { id: "o1-mini", label: "o1 Mini" },
    // Legacy
    { id: "gpt-3.5-turbo", label: "GPT-3.5 Turbo" },
  ],

  anthropic: [
    // Claude 4
    { id: "claude-opus-4-20250514", label: "Claude Opus 4" },
    { id: "claude-sonnet-4-20250514", label: "Claude Sonnet 4" },
    // Claude 3.5
    { id: "claude-3-5-sonnet-20241022", label: "Claude 3.5 Sonnet v2" },
    { id: "claude-3-5-haiku-20241022", label: "Claude 3.5 Haiku" },
    // Claude 3
    { id: "claude-3-opus-20240229", label: "Claude 3 Opus" },
    { id: "claude-3-sonnet-20240229", label: "Claude 3 Sonnet" },
    { id: "claude-3-haiku-20240307", label: "Claude 3 Haiku" },
  ],

  google: [
    // Gemini 2.5
    { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
    { id: "gemini-2.5-pro-preview", label: "Gemini 2.5 Pro Preview" },
    { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
    { id: "gemini-2.5-flash-preview", label: "Gemini 2.5 Flash Preview" },
    { id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash-Lite" },
    // Gemini 2.0
    { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash" },
    { id: "gemini-2.0-flash-lite", label: "Gemini 2.0 Flash-Lite" },
    // Gemini 1.5
    { id: "gemini-1.5-pro", label: "Gemini 1.5 Pro" },
    { id: "gemini-1.5-flash", label: "Gemini 1.5 Flash" },
    { id: "gemini-1.5-flash-8b", label: "Gemini 1.5 Flash-8B" },
  ],

  mimo: [
    { id: "mimo-v2-pro", label: "MiMo-V2 Pro (1M context)" },
    { id: "mimo-v2-omni", label: "MiMo-V2 Omni (multimodal)" },
    { id: "mimo-v2-flash", label: "MiMo-V2 Flash (fast)" },
    { id: "mimo-v2-tts", label: "MiMo-V2 TTS (text-to-speech)" },
  ],

  mistral: [
    // Flagship
    { id: "mistral-large-latest", label: "Mistral Large (latest)" },
    { id: "mistral-medium-latest", label: "Mistral Medium (latest)" },
    { id: "mistral-small-latest", label: "Mistral Small (latest)" },
    // Reasoning
    { id: "magistral-medium-latest", label: "Magistral Medium (reasoning)" },
    { id: "magistral-small-latest", label: "Magistral Small (reasoning)" },
    // Coding
    { id: "codestral-latest", label: "Codestral (code)" },
    { id: "devstral-2512", label: "Devstral 2 (agentic code)" },
    // Vision
    { id: "pixtral-large-latest", label: "Pixtral Large (vision)" },
    // Edge
    { id: "ministral-8b-latest", label: "Ministral 8B (edge)" },
    { id: "ministral-3b-latest", label: "Ministral 3B (edge)" },
  ],
};

export function getModelsForProvider(provider: string): ModelOption[] {
  return PROVIDER_MODELS[provider] || [];
}

export function getDefaultModel(provider: string): string {
  const models = PROVIDER_MODELS[provider];
  return models?.[0]?.id || "";
}
