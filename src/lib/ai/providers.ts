/** Model providers. Everything except Anthropic speaks the OpenAI Chat Completions format. */
export interface ProviderPreset {
  id: string;
  name: string;
  api: "anthropic" | "openai";
  baseUrl: string;
  /** Suggested default model. */
  model: string;
  /** Other common models offered in the picker before "Load models" is used. */
  models: string[];
  needsKey: boolean;
  /** Where to get an API key. */
  keyUrl?: string;
  /** Base URL must be entered by the user. */
  customUrl?: boolean;
  local?: boolean;
}

export const PROVIDERS: ProviderPreset[] = [
  { id: "anthropic", name: "Anthropic", api: "anthropic", baseUrl: "https://api.anthropic.com", model: "claude-sonnet-5-5",
    models: ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5"], needsKey: true, keyUrl: "https://console.anthropic.com/settings/keys" },
  { id: "openai", name: "OpenAI", api: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-5",
    models: ["gpt-5", "gpt-5-mini", "gpt-4.1"], needsKey: true, keyUrl: "https://platform.openai.com/api-keys" },
  { id: "gemini", name: "Google Gemini", api: "openai", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-2.5-flash",
    models: ["gemini-2.5-flash", "gemini-2.5-pro"], needsKey: true, keyUrl: "https://aistudio.google.com/apikey" },
  { id: "openrouter", name: "OpenRouter", api: "openai", baseUrl: "https://openrouter.ai/api/v1", model: "anthropic/claude-sonnet-5.5",
    models: ["anthropic/claude-sonnet-5.5", "openai/gpt-5", "google/gemini-2.5-pro", "deepseek/deepseek-chat"], needsKey: true, keyUrl: "https://openrouter.ai/keys" },
  { id: "groq", name: "Groq", api: "openai", baseUrl: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile",
    models: ["llama-3.3-70b-versatile"], needsKey: true, keyUrl: "https://console.groq.com/keys" },
  { id: "deepseek", name: "DeepSeek", api: "openai", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat",
    models: ["deepseek-chat", "deepseek-reasoner"], needsKey: true, keyUrl: "https://platform.deepseek.com/api_keys" },
  { id: "mistral", name: "Mistral", api: "openai", baseUrl: "https://api.mistral.ai/v1", model: "mistral-large-latest",
    models: ["mistral-large-latest", "codestral-latest"], needsKey: true, keyUrl: "https://console.mistral.ai/api-keys" },
  { id: "xai", name: "xAI", api: "openai", baseUrl: "https://api.x.ai/v1", model: "grok-4",
    models: ["grok-4"], needsKey: true, keyUrl: "https://console.x.ai" },
  { id: "ollama", name: "Ollama", api: "openai", baseUrl: "http://localhost:11434/v1", model: "qwen2.5-coder",
    models: ["qwen2.5-coder", "llama3.1"], needsKey: false, local: true },
  { id: "lmstudio", name: "LM Studio", api: "openai", baseUrl: "http://localhost:1234/v1", model: "",
    models: [], needsKey: false, local: true },
  { id: "custom", name: "OpenAI-compatible", api: "openai", baseUrl: "", model: "",
    models: [], needsKey: false, customUrl: true },
];

export const providerById = (id: string) => PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0];

export interface AiConfigLike { provider: string; models: Record<string, string>; baseUrls: Record<string, string> }

/** The effective provider, base URL and model for the current settings. */
export function resolveProvider(ai: AiConfigLike) {
  const p = providerById(ai.provider);
  return { preset: p, baseUrl: (ai.baseUrls?.[p.id] || p.baseUrl).trim(), model: (ai.models?.[p.id] || p.model).trim() };
}
