// LLM provider + model catalog for the bring-your-own-key picker.
// Models are suggestions; the backend accepts any model string the provider supports.

export type Provider = "groq" | "openai" | "anthropic";

export const PROVIDERS: { id: Provider; label: string; models: string[] }[] = [
  {
    id: "groq",
    label: "Groq",
    models: ["llama-3.1-8b-instant", "llama-3.3-70b-versatile"],
  },
  {
    id: "openai",
    label: "OpenAI",
    models: ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini"],
  },
  {
    id: "anthropic",
    label: "Anthropic",
    models: ["claude-3-5-haiku-latest", "claude-3-5-sonnet-latest"],
  },
];

export const providerLabel = (id: string) =>
  PROVIDERS.find((p) => p.id === id)?.label ?? id;

export const modelsFor = (id: string) =>
  PROVIDERS.find((p) => p.id === id)?.models ?? [];
