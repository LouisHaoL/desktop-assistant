export interface ProviderPreset {
  id: string;
  name: string;
  baseUrl: string;
  models: string[];
  needsKey: boolean;
  docs?: string;
}

/** 参考 cc-switch 的预设模式:常用供应商一键填充,支持自定义 OpenAI 兼容端点 */
export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    models: ["deepseek-chat", "deepseek-reasoner"],
    needsKey: true,
    docs: "https://platform.deepseek.com",
  },
  {
    id: "zhipu",
    name: "智谱 GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    models: ["glm-4-flash", "glm-4-air", "glm-4-plus"],
    needsKey: true,
    docs: "https://open.bigmodel.cn",
  },
  {
    id: "moonshot",
    name: "Kimi (Moonshot)",
    baseUrl: "https://api.moonshot.cn/v1",
    models: ["kimi-latest", "moonshot-v1-8k", "moonshot-v1-32k"],
    needsKey: true,
    docs: "https://platform.moonshot.cn",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    models: ["openrouter/auto", "anthropic/claude-sonnet-4", "deepseek/deepseek-chat"],
    needsKey: true,
    docs: "https://openrouter.ai",
  },
  {
    id: "ollama",
    name: "Ollama(本机)",
    baseUrl: "http://localhost:11434/v1",
    models: ["qwen2.5:7b", "llama3.1:8b"],
    needsKey: false,
    docs: "https://ollama.com",
  },
  {
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    models: ["gpt-4o-mini", "gpt-4o"],
    needsKey: true,
    docs: "https://platform.openai.com",
  },
  {
    id: "anthropic",
    name: "Anthropic(兼容端点)",
    baseUrl: "https://api.anthropic.com/v1",
    models: ["claude-sonnet-4", "claude-haiku-4"],
    needsKey: true,
    docs: "https://docs.anthropic.com",
  },
  {
    id: "custom",
    name: "自定义(OpenAI 兼容)",
    baseUrl: "",
    models: [],
    needsKey: true,
  },
];
