import { parse } from "dotenv";
import { readFile } from "node:fs/promises";
import path from "node:path";

const ENV_PATH = path.resolve(".env");

/** 从 .env 重新载入环境变量（覆盖当前进程中的同名变量）。 */
export async function loadEnvFromFile() {
  let text = "";
  try {
    text = await readFile(ENV_PATH, "utf8");
  } catch {
    return;
  }
  const parsed = parse(text);
  for (const [key, value] of Object.entries(parsed)) {
    if (value !== undefined) process.env[key] = value;
  }
}
