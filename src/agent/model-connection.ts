import { ModelRuntime } from "@earendil-works/pi-coding-agent";

export interface ModelConnection {
  baseUrl: string;
  modelName: string;
  apiKey: string;
  contextWindow: number;
  maxOutputTokens: number;
}

function positiveInteger(value: string | undefined, fallback: number, name: string) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${name} 必须是正整数`);
  return number;
}

export function readModelConnection(env: NodeJS.ProcessEnv = process.env): ModelConnection {
  if (!env.MODEL_BASE_URL?.trim() || !env.MODEL_NAME?.trim()) {
    throw new Error("请在 .env 中配置 MODEL_BASE_URL 和 MODEL_NAME；Agent 只连接外部模型 API");
  }
  let url: URL;
  try { url = new URL(env.MODEL_BASE_URL.trim()); }
  catch { throw new Error("MODEL_BASE_URL 必须是有效的 HTTP(S) 地址"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("MODEL_BASE_URL 只能使用 HTTP(S)，且不得包含凭据、查询参数或片段");
  }
  const contextWindow = positiveInteger(env.MODEL_CONTEXT_WINDOW, 8192, "MODEL_CONTEXT_WINDOW");
  const maxOutputTokens = positiveInteger(env.MODEL_MAX_OUTPUT_TOKENS, 1024, "MODEL_MAX_OUTPUT_TOKENS");
  if (maxOutputTokens >= contextWindow) throw new Error("输出 Token 上限必须小于上下文窗口");
  return {
    baseUrl: url.toString().replace(/\/+$/, ""),
    modelName: env.MODEL_NAME.trim(),
    apiKey: env.MODEL_API_KEY?.trim() || "local",
    contextWindow,
    maxOutputTokens,
  };
}

export async function createConnectedModel(connection: ModelConnection) {
  // Configure a remote API consumer only. No model files, inference engine or child process.
  const modelRuntime = await ModelRuntime.create({
    credentials: {
      read: async () => undefined,
      list: async () => [],
      modify: async () => { throw new Error("凭据持久化未启用，请通过环境变量配置"); },
      delete: async () => {},
    },
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const providerId = "aftercare-api";
  modelRuntime.registerProvider(providerId, {
    name: "Aftercare external model API",
    baseUrl: connection.baseUrl,
    api: "openai-completions",
    // Resolve the key through an environment reference, never as executable config text.
    apiKey: "$MODEL_API_KEY",
    models: [{
      id: connection.modelName,
      name: connection.modelName,
      reasoning: false,
      input: ["text"],
      contextWindow: connection.contextWindow,
      maxTokens: connection.maxOutputTokens,
      // No price is assumed for arbitrary endpoints; token usage is still reported.
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: { supportsDeveloperRole: false, supportsStore: false, maxTokensField: "max_tokens" },
    }],
  });
  await modelRuntime.setRuntimeApiKey(providerId, connection.apiKey);
  const model = modelRuntime.getModel(providerId, connection.modelName);
  if (!model) throw new Error("模型 API 配置未能注册");
  return { modelRuntime, model };
}
