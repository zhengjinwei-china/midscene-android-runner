/**
 * 需要大模型思考的调用都集中在这里。
 * 接口未提供时，readModelConfig() 返回 null。
 * 控制台「系统配置」写入的值会覆盖进程环境变量，并同步到 .env。
 * 默认按 OpenAI 兼容的 POST {baseUrl}/chat/completions 调用。
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { refreshMidsceneModelEnv } from "./midscene-env.js";

const ENV_PATH = path.resolve(".env");

export const MODEL_ENV_KEYS = [
  "PLANNER_MODEL_BASE_URL",
  "PLANNER_MODEL_API_KEY",
  "PLANNER_MODEL_NAME",
  "MIDSCENE_MODEL_BASE_URL",
  "MIDSCENE_MODEL_API_KEY",
  "MIDSCENE_MODEL_NAME",
  "MIDSCENE_MODEL_FAMILY",
] as const;

export type ModelEnvKey = (typeof MODEL_ENV_KEYS)[number];

export interface ModelConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  source: "planner" | "midscene";
}

export function readModelConfig(): ModelConfig | null {
  const plannerBase = process.env.PLANNER_MODEL_BASE_URL?.trim();
  const plannerKey = process.env.PLANNER_MODEL_API_KEY?.trim();
  const plannerName = process.env.PLANNER_MODEL_NAME?.trim();
  if (plannerBase && plannerKey && plannerName) {
    return {
      baseUrl: plannerBase,
      apiKey: plannerKey,
      model: plannerName,
      source: "planner",
    };
  }

  const baseUrl = process.env.MIDSCENE_MODEL_BASE_URL?.trim();
  const apiKey = process.env.MIDSCENE_MODEL_API_KEY?.trim();
  const model = process.env.MIDSCENE_MODEL_NAME?.trim();
  if (baseUrl && apiKey && model) {
    return { baseUrl, apiKey, model, source: "midscene" };
  }
  return null;
}

function envValue(key: ModelEnvKey) {
  return process.env[key]?.trim() ?? "";
}

export function modelSettingsView() {
  return {
    planner: {
      baseUrl: envValue("PLANNER_MODEL_BASE_URL"),
      apiKeySet: Boolean(envValue("PLANNER_MODEL_API_KEY")),
      model: envValue("PLANNER_MODEL_NAME"),
    },
    midscene: {
      baseUrl: envValue("MIDSCENE_MODEL_BASE_URL"),
      apiKeySet: Boolean(envValue("MIDSCENE_MODEL_API_KEY")),
      model: envValue("MIDSCENE_MODEL_NAME"),
      family: envValue("MIDSCENE_MODEL_FAMILY") || "gpt-5",
    },
  };
}

/** 空字符串的密钥表示保留已保存的值。其余字段按提交内容覆盖。 */
export async function saveModelSettings(input: Partial<Record<ModelEnvKey, string>>) {
  const next: Partial<Record<ModelEnvKey, string>> = {};
  for (const key of MODEL_ENV_KEYS) {
    const value = input[key];
    if (value === undefined) continue;
    const trimmed = value.trim();
    if (key.endsWith("_API_KEY") && !trimmed) continue;
    next[key] = trimmed;
    process.env[key] = trimmed;
  }
  await upsertEnvFile(next);
  await refreshMidsceneModelEnv();
  return modelSettingsView();
}

async function upsertEnvFile(updates: Partial<Record<ModelEnvKey, string>>) {
  let text = "";
  try {
    text = await readFile(ENV_PATH, "utf8");
  } catch {
    text = "";
  }
  const lines = text.length ? text.split(/\r?\n/) : [];
  const seen = new Set<string>();
  const rewritten = lines.map((line) => {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match) return line;
    const key = match[1] as ModelEnvKey;
    if (!(key in updates)) return line;
    seen.add(key);
    return `${key}=${updates[key] ?? ""}`;
  });
  for (const key of MODEL_ENV_KEYS) {
    if (!(key in updates) || seen.has(key)) continue;
    if (rewritten.length && rewritten[rewritten.length - 1] !== "") rewritten.push("");
    rewritten.push(`${key}=${updates[key] ?? ""}`);
  }
  const body = rewritten.join("\n");
  await writeFile(ENV_PATH, body.endsWith("\n") || body.length === 0 ? body : `${body}\n`);
}

export function modelStatus() {
  const plannerReady = Boolean(
    process.env.PLANNER_MODEL_BASE_URL?.trim() &&
      process.env.PLANNER_MODEL_API_KEY?.trim() &&
      process.env.PLANNER_MODEL_NAME?.trim(),
  );
  const midsceneReady = Boolean(
    process.env.MIDSCENE_MODEL_BASE_URL?.trim() &&
      process.env.MIDSCENE_MODEL_API_KEY?.trim() &&
      process.env.MIDSCENE_MODEL_NAME?.trim() &&
      process.env.MIDSCENE_MODEL_FAMILY?.trim(),
  );
  return {
    configured: plannerReady || midsceneReady,
    plannerReady,
    plannerModel: envValue("PLANNER_MODEL_NAME") || null,
    midsceneReady,
    midsceneModel: envValue("MIDSCENE_MODEL_NAME") || null,
    midsceneFamily: envValue("MIDSCENE_MODEL_FAMILY") || null,
  };
}

function chatUrl(baseUrl: string) {
  const trimmed = baseUrl.replace(/\/+$/, "");
  if (trimmed.endsWith("/chat/completions")) return trimmed;
  return `${trimmed}/chat/completions`;
}

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export async function chat(system: string, user: string): Promise<string> {
  return chatMessages(system, [{ role: "user", content: user }]);
}

export async function chatMessages(system: string, turns: ChatTurn[]): Promise<string> {
  const config = readModelConfig();
  if (!config) {
    throw new Error(
      "大模型接口尚未配置。请在控制台上方的「系统配置」里填写。",
    );
  }
  if (!turns.length) throw new Error("请输入要问的内容");

  const response = await fetch(chatUrl(config.baseUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      temperature: 0.2,
      messages: [
        { role: "system", content: system },
        ...turns.map((turn) => ({ role: turn.role, content: turn.content })),
      ],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`大模型接口返回 ${response.status}：${body.slice(0, 500)}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("大模型没有返回内容");
  return content;
}

export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced?.[1] ?? text;
  const start = raw.search(/[\[{]/);
  if (start < 0) throw new Error("大模型返回里没有 JSON");
  return JSON.parse(raw.slice(start));
}
