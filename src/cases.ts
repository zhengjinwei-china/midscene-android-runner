import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chat, extractJson, readModelConfig } from "./llm.js";
import { getAppSettings } from "./settings.js";
import type { Step, TestCase } from "./types.js";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const casesDir = path.join(projectRoot, "data/cases");

const PLAN_SYSTEM = `你是 Android UI 自动化测试设计师。用户会用自然语言描述一个或多个测试案例。
请把每个案例拆成 Midscene 能直接执行的步骤，只输出 JSON，不要解释。

输出格式：
{
  "cases": [
    {
      "name": "简短案例名",
      "packageName": "可选，Android 包名，不知道就省略",
      "steps": [
        { "type": "action", "instruction": "同一屏上的连续操作合成一句" },
        { "type": "assert", "instruction": "同一屏上要核对的现象合成一句" }
      ]
    }
  ]
}

规则：
- type 只能是 action 或 assert。同一页面上的点击、输入、滑动合成一条 action；同一页面上的检查合成一条 assert。只有换页或必须先看到结果才能继续时才新开一步。
- 用户描述里的“检查、确认、应该、断言、看到”放进 assert，其余放进 action。
- **自动补充断言**：用户没写检查点时，也要根据操作意图补上合理 assert，避免案例只有 action。
  - 打开/启动 App 后，若还有后续操作，可插一条 assert：主界面或首页已加载、无明显闪退/白屏。
  - 进入频道、Tab、二级页、详情、列表、弹窗关闭后等「到达新页面」的操作之后，必须紧跟一条 assert：已成功进入目标（用用户提到的名称，如「美食频道」），页面展示正常（核心区域有内容、无全屏错误/空白、无明显加载失败提示）。
  - 案例以「进入某处、打开某页、跳转到…」结束时，最后一步必须是 assert，写清到达目标且界面正常。
  - 用户已写的断言保留并合并同屏检查；不要重复同一句，可把「到达目标」与「界面正常」合成一条 assert。
- instruction 用短句写清点哪里、输入什么、应该看到什么。不要背景说明，不要“请帮我”。
- 每条 instruction 自洽，不依赖“同上”。
- 不要发明用户没提到的账号密码；用户给了就原样写入 instruction。自动断言只描述页面/频道级现象，不要编造具体商品名、价格、账号数据。
- packageName 只在非常确定时使用；不要编造包名。不确定就省略该字段，由执行步骤在桌面上点击图标打开应用。
- 多个案例用 --- 或“案例”分隔时要拆开。`;

export const DEFAULT_SPLIT_PROMPT = `你是 Android UI 自动化测试设计师。用户会给出一条已经理解成功的长案例，以及带编号的 action/assert 步骤。
这些子案例会按顺序在同一次批量执行里接续：上一条停在哪一屏，下一条就从哪一屏开始。只输出 JSON，不要解释，不要改写步骤原文。

输出格式：
{
  "cases": [
    { "name": "进入商超页面且展示正常", "from": 1, "to": 4 }
  ]
}

规则：
- 一个子案例对应一个业务检查点，并且必须以 assert 结束。name 用短标题，写清到达哪里、结果是否正常。
- 一条 action 和紧跟它的 assert 必须在同一个子案例里。禁止把操作留在上一条、把断言单独放到下一条。
- from、to 是步骤编号（含两端），必须连续、不重叠、不漏步，并按原顺序覆盖全部步骤。
- 打开 App、首页加载这类入口只放在第一条里。后面的子案例不要再包含打开应用，它们从上一子案例最后一条 assert 所在的页面继续。
- 只是路过的中间页要并进下一个真正目的地。例如「打开 App」后的「首页已加载」若后面紧接着进入商超并断言商超页正常，则合成一条「进入商超页面且展示正常」，不要单独拆成「打开 App」。
- 搜索成功、进入门店跳转成功、详情页展示正常、周边商户、下滑查看商家信息，若各自已有 assert，则各自独立成条。
- 一条 assert 已经同时写了「跳转成功」和「页面展示正常」时，保持为一条，不要拆成两个没有步骤的案例。
- 不要新增、删除或改写步骤，只做分组。`;

export async function ensureCasesDir() {
  await mkdir(casesDir, { recursive: true });
}

function isStep(value: unknown): value is Step {
  if (!value || typeof value !== "object") return false;
  const step = value as Step;
  return (
    (step.type === "action" || step.type === "assert") &&
    typeof step.instruction === "string" &&
    step.instruction.trim().length > 0
  );
}

function normalizeStep(step: Step): Step {
  const next: Step = {
    type: step.type,
    instruction: step.instruction.trim(),
  };
  if (step.skipOnBatchContinue) next.skipOnBatchContinue = true;
  return next;
}

export function normalizeCase(input: unknown, rawFallback = ""): TestCase {
  if (!input || typeof input !== "object") {
    throw new Error("案例格式不正确");
  }
  const body = input as Partial<TestCase> & { steps?: unknown[] };
  const steps = Array.isArray(body.steps) ? body.steps.filter(isStep) : [];
  const raw =
    typeof body.raw === "string" && body.raw.trim()
      ? body.raw.trim()
      : rawFallback.trim() ||
        steps.map((step) => `${step.type}: ${step.instruction}`).join("\n");
  const name =
    typeof body.name === "string" && body.name.trim()
      ? body.name.trim()
      : raw.split("\n")[0]?.slice(0, 40) || "未命名案例";
  if (!raw) throw new Error("案例内容为空");
  const packageName =
    typeof body.packageName === "string" &&
    /^[A-Za-z][\w.]*$/.test(body.packageName.trim())
      ? body.packageName.trim()
      : undefined;
  const batchSkipRaw = (body as Partial<TestCase>).batchSkipSteps;
  const batchSkipSteps =
    typeof batchSkipRaw === "number" &&
    Number.isFinite(batchSkipRaw) &&
    batchSkipRaw > 0
      ? Math.floor(batchSkipRaw)
      : undefined;
  const sourceCaseId =
    typeof body.sourceCaseId === "string" && body.sourceCaseId.trim()
      ? body.sourceCaseId.trim()
      : undefined;
  const splitOrderRaw = body.splitOrder;
  const splitOrder =
    typeof splitOrderRaw === "number" &&
    Number.isFinite(splitOrderRaw) &&
    splitOrderRaw > 0
      ? Math.floor(splitOrderRaw)
      : undefined;
  return {
    id: typeof body.id === "string" && body.id ? body.id : randomUUID(),
    name,
    raw,
    packageName,
    batchSkipSteps,
    steps: steps.map((step) => normalizeStep(step)),
    planError: typeof body.planError === "string" ? body.planError : undefined,
    sourceCaseId,
    splitOrder,
    updatedAt: new Date().toISOString(),
  };
}

interface SplitGroup {
  name: string;
  from: number;
  to: number;
}

function validateSplitGroups(value: unknown, stepCount: number): SplitGroup[] {
  const body = value as { cases?: unknown[] } | unknown[] | null;
  const list = Array.isArray(body)
    ? body
    : body && typeof body === "object" && Array.isArray(body.cases)
      ? body.cases
      : null;
  if (!list?.length) throw new Error("大模型没有拆出子案例");
  const groups: SplitGroup[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") throw new Error("拆分结果格式不正确");
    const row = item as { name?: unknown; from?: unknown; to?: unknown };
    const name = typeof row.name === "string" ? row.name.trim() : "";
    const from = row.from;
    const to = row.to;
    if (!name) throw new Error("子案例名称不能为空");
    if (
      typeof from !== "number" ||
      typeof to !== "number" ||
      !Number.isInteger(from) ||
      !Number.isInteger(to)
    ) {
      throw new Error("拆分范围必须是整数步骤编号");
    }
    if (to < from) throw new Error("拆分范围结束不能早于开始");
    groups.push({ name, from, to });
  }
  groups.sort((a, b) => a.from - b.from);
  if (groups[0]!.from !== 1 || groups[groups.length - 1]!.to !== stepCount) {
    throw new Error("拆分没有按顺序覆盖全部步骤");
  }
  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index]!;
    if (group.from < 1 || group.to > stepCount) {
      throw new Error("拆分范围超出步骤编号");
    }
    if (index === 0) continue;
    if (group.from !== groups[index - 1]!.to + 1) {
      throw new Error("拆分范围有重叠或漏步");
    }
  }
  return groups;
}

/** 操作和紧跟的断言必须留在同一子案例，否则批量接续时下一条会从错误页面开始。 */
function alignGroupsToChecks(groups: SplitGroup[], steps: Step[]): SplitGroup[] {
  const merged: SplitGroup[] = groups.map((group) => ({ ...group }));
  for (let index = 0; index < merged.length - 1; ) {
    const current = merged[index]!;
    const next = merged[index + 1]!;
    if (steps[current.to - 1]?.type !== "action" || steps[next.from - 1]?.type !== "assert") {
      index += 1;
      continue;
    }
    let takeUntil = next.from;
    while (takeUntil <= next.to && steps[takeUntil - 1]?.type === "assert") takeUntil += 1;
    current.to = takeUntil - 1;
    next.from = takeUntil;
    if (next.from > next.to) merged.splice(index + 1, 1);
  }
  return merged;
}

function continuationNote(previousAssert: string) {
  const screen = previousAssert.replace(/\s+/g, " ").slice(0, 80);
  return `从上一子案例结束时的页面继续（${screen}）。不要重新打开应用，不要回到桌面。`;
}

/** 把已理解的长案例按业务检查点切成可批量接续的子案例。 */
export async function splitCase(id: string): Promise<TestCase[]> {
  const parent = await getCase(id);
  if (!parent) throw new Error("案例不存在");
  if (!parent.steps.length) throw new Error("案例还没有可执行步骤，请先理解");
  if (!readModelConfig()) {
    throw new Error("大模型接口尚未配置。请在控制台上方的「系统配置」里填写。");
  }

  const numbered = parent.steps
    .map((step, index) => `${index + 1}. ${step.type}: ${step.instruction}`)
    .join("\n");
  const settings = await getAppSettings();
  const content = await chat(
    settings.splitPrompt.trim() || DEFAULT_SPLIT_PROMPT,
    `案例名称：${parent.name}\n原文：\n${parent.raw}\n\n已理解步骤：\n${numbered}`,
  );
  const groups = alignGroupsToChecks(
    validateSplitGroups(extractJson(content), parent.steps.length),
    parent.steps,
  );

  const existing = await listCases();
  for (const item of existing) {
    if (item.sourceCaseId === parent.id) await deleteCase(item.id);
  }

  const saved: TestCase[] = [];
  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index]!;
    const steps = parent.steps.slice(group.from - 1, group.to).map((step, stepIndex) => {
      let instruction = step.instruction;
      if (index > 0 && stepIndex === 0) {
        const previous = groups[index - 1]!;
        const previousAssert = [...parent.steps.slice(previous.from - 1, previous.to)]
          .reverse()
          .find((item) => item.type === "assert");
        if (previousAssert) {
          instruction = `${continuationNote(previousAssert.instruction)}${instruction}`;
        }
      }
      return {
        type: step.type,
        instruction,
        ...(step.skipOnBatchContinue ? { skipOnBatchContinue: true } : {}),
      };
    });
    const raw = steps
      .map((step) => `${step.type === "action" ? "操作" : "断言"}：${step.instruction}`)
      .join("\n");
    const child = normalizeCase({
      name: group.name,
      raw,
      steps,
      packageName: index === 0 ? parent.packageName : undefined,
      sourceCaseId: parent.id,
      splitOrder: index + 1,
    });
    saved.push(await saveCase(child));
  }
  return saved;
}

/** 把自然语言交给大模型，拆成 Midscene 的 action / assert。 */
export async function planNaturalLanguage(raw: string): Promise<TestCase[]> {
  if (!readModelConfig()) {
    return [
      normalizeCase({
        name: raw.split("\n")[0]?.slice(0, 40) || "未命名案例",
        raw,
        steps: [],
        planError: "大模型接口尚未配置，案例已保存，配置后可重新理解。",
      }),
    ];
  }

  const content = await chat(PLAN_SYSTEM, raw);
  const parsed = extractJson(content) as { cases?: unknown[] } | unknown[];
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed.cases)
      ? parsed.cases
      : [parsed];
  const cases = list.map((item) =>
    normalizeCase(item, list.length === 1 ? raw : ""),
  );
  const ready = cases.filter((item) => item.steps.length > 0);
  if (!ready.length) throw new Error("大模型没有拆出可执行步骤");
  return ready;
}

export async function listCases(): Promise<TestCase[]> {
  await ensureCasesDir();
  const files = (await readdir(casesDir)).filter((name) => name.endsWith(".json"));
  const cases = await Promise.all(
    files.map(async (file) =>
      JSON.parse(await readFile(path.join(casesDir, file), "utf8")) as TestCase,
    ),
  );
  return cases.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function getCase(id: string): Promise<TestCase | null> {
  try {
    return JSON.parse(
      await readFile(path.join(casesDir, `${id}.json`), "utf8"),
    ) as TestCase;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await ensureCasesDir();
  for (const name of await readdir(casesDir)) {
    if (!name.endsWith(".json")) continue;
    const parsed = JSON.parse(
      await readFile(path.join(casesDir, name), "utf8"),
    ) as TestCase;
    if (parsed.id === id) return parsed;
  }
  return null;
}

export async function saveCase(testCase: TestCase) {
  await ensureCasesDir();
  await writeFile(
    path.join(casesDir, `${testCase.id}.json`),
    JSON.stringify(testCase, null, 2),
  );
  return testCase;
}

export type CaseUpdateInput = {
  name?: string;
  raw?: string;
  packageName?: string | null;
  steps?: Step[];
};

export async function updateCase(id: string, input: CaseUpdateInput) {
  const existing = await getCase(id);
  if (!existing) throw new Error("案例不存在");

  const name =
    input.name !== undefined ? input.name.trim() : existing.name;
  const raw = input.raw !== undefined ? input.raw.trim() : existing.raw;
  if (!name) throw new Error("案例名称不能为空");
  if (!raw) throw new Error("案例原文不能为空");

  let packageName = existing.packageName;
  if (input.packageName !== undefined) {
    const trimmed = input.packageName?.trim() ?? "";
    if (!trimmed) {
      packageName = undefined;
    } else if (/^[A-Za-z][\w.]*$/.test(trimmed)) {
      packageName = trimmed;
    } else {
      throw new Error("包名格式不正确");
    }
  }

  let steps = existing.steps;
  if (input.steps !== undefined) {
    steps = input.steps.filter(isStep).map((step) => normalizeStep(step));
  }

  const updated: TestCase = {
    ...existing,
    name,
    raw,
    packageName,
    steps,
    updatedAt: new Date().toISOString(),
  };
  if (steps.some((step) => step.skipOnBatchContinue)) {
    delete updated.batchSkipSteps;
  }
  if (steps.length > 0) {
    delete updated.planError;
  } else if (!updated.planError) {
    updated.planError = "尚未理解成步骤";
  }

  return saveCase(updated);
}

export async function deleteCase(id: string) {
  await ensureCasesDir();
  const directPath = path.join(casesDir, `${id}.json`);
  try {
    await unlink(directPath);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  for (const name of await readdir(casesDir)) {
    if (!name.endsWith(".json")) continue;
    const filePath = path.join(casesDir, name);
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as TestCase;
    if (parsed.id === id) {
      await unlink(filePath);
      return;
    }
  }
  throw new Error("案例文件不存在");
}
