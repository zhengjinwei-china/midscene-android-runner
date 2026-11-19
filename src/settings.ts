import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const settingsPath = path.resolve("data/settings.json");

export interface AppSettings {
  /** 手机执行时注入 Midscene 的全局指引（弹窗、授权等） */
  globalPrompt: string;
  /** 拆分案例的系统提示词；空字符串表示使用内置默认 */
  splitPrompt: string;
}

const defaults: AppSettings = { globalPrompt: "", splitPrompt: "" };

async function readSettingsFile(): Promise<AppSettings> {
  try {
    const raw = JSON.parse(await readFile(settingsPath, "utf8")) as Partial<AppSettings>;
    return {
      globalPrompt:
        typeof raw.globalPrompt === "string" ? raw.globalPrompt : defaults.globalPrompt,
      splitPrompt:
        typeof raw.splitPrompt === "string" ? raw.splitPrompt : defaults.splitPrompt,
    };
  } catch {
    return { ...defaults };
  }
}

export async function getAppSettings(): Promise<AppSettings> {
  await mkdir(path.dirname(settingsPath), { recursive: true });
  return readSettingsFile();
}

export async function savePrompts(input: Partial<AppSettings>): Promise<AppSettings> {
  await mkdir(path.dirname(settingsPath), { recursive: true });
  const current = await readSettingsFile();
  const next: AppSettings = {
    globalPrompt:
      input.globalPrompt !== undefined ? input.globalPrompt : current.globalPrompt,
    splitPrompt:
      input.splitPrompt !== undefined ? input.splitPrompt : current.splitPrompt,
  };
  await writeFile(settingsPath, JSON.stringify(next, null, 2));
  return next;
}
