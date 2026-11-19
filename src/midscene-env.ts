import { globalModelConfigManager } from "@midscene/shared/env";
import { loadEnvFromFile } from "./env.js";

/** 重新读取 .env，并清掉 Midscene 对模型配置的进程内缓存。 */
export async function refreshMidsceneModelEnv() {
  await loadEnvFromFile();
  globalModelConfigManager.clearModelConfigMap();
}
