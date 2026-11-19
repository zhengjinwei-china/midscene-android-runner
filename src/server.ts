import "dotenv/config";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import {
  deleteCase,
  getCase,
  listCases,
  planNaturalLanguage,
  saveCase,
  splitCase,
  updateCase,
  DEFAULT_SPLIT_PROMPT,
  type CaseUpdateInput,
} from "./cases.js";
import { refreshMidsceneModelEnv } from "./midscene-env.js";
import { chatMessages, MODEL_ENV_KEYS, modelSettingsView, modelStatus, saveModelSettings, type ChatTurn, type ModelEnvKey } from "./llm.js";
import {
  cancelRun,
  getActiveRunId,
  getRun,
  listDevices,
  startRun,
  subscribe,
} from "./runner.js";
import { readAskHistory, runDir, saveAskHistory } from "./report.js";
import { getHistoricalExecutionStats, listCaseRunHistory } from "./run-history.js";
import { getAppSettings, savePrompts } from "./settings.js";
import { casesToXlsx } from "./export-cases.js";

const app = Fastify({ logger: true });
const port = Number(process.env.PORT || 3920);

app.addHook("onSend", async (request, reply, payload) => {
  if (request.url.startsWith("/api/")) {
    reply.header("Cache-Control", "no-store, must-revalidate");
    reply.header("Pragma", "no-cache");
  }
  return payload;
});

async function removeCaseById(id: string) {
  const existing = await getCase(id);
  if (!existing) {
    throw new Error("案例不存在");
  }
  await deleteCase(id);
  return { ok: true };
}

await mkdir(path.resolve("data/runs"), { recursive: true });
await mkdir(path.resolve("data/cases"), { recursive: true });

await app.register(fastifyStatic, {
  root: path.resolve("web"),
  prefix: "/",
  setHeaders: (res, filePath) => {
    if (/\.(html|js|css)$/i.test(filePath)) {
      res.setHeader("Cache-Control", "no-store");
    }
  },
});
await app.register(fastifyStatic, {
  root: path.resolve("data/runs"),
  prefix: "/runs/",
  decorateReply: false,
});

app.get("/api/status", async () => ({
  ...modelStatus(),
  activeRunId: getActiveRunId(),
}));

app.post("/api/server/restart", async (_request, reply) => {
  if (getActiveRunId()) {
    return reply.code(409).send({ error: "有任务正在执行，请等结束后再重新加载。" });
  }
  await refreshMidsceneModelEnv();
  return { ok: true, ...modelStatus() };
});

app.get("/api/settings/model", async () => modelSettingsView());

app.get("/api/settings/prompts", async () => {
  const settings = await getAppSettings();
  const custom = settings.splitPrompt.trim();
  return {
    globalPrompt: settings.globalPrompt,
    splitPrompt: custom || DEFAULT_SPLIT_PROMPT,
  };
});

app.put<{ Body: { globalPrompt?: string; splitPrompt?: string } }>(
  "/api/settings/prompts",
  async (request, reply) => {
    const body = request.body ?? {};
    if (body.globalPrompt !== undefined && typeof body.globalPrompt !== "string") {
      return reply.code(400).send({ error: "globalPrompt 必须是字符串" });
    }
    if (body.splitPrompt !== undefined && typeof body.splitPrompt !== "string") {
      return reply.code(400).send({ error: "splitPrompt 必须是字符串" });
    }
    const patch: { globalPrompt?: string; splitPrompt?: string } = {};
    if (body.globalPrompt !== undefined) patch.globalPrompt = body.globalPrompt;
    if (body.splitPrompt !== undefined) {
      const trimmed = body.splitPrompt.trim();
      patch.splitPrompt =
        !trimmed || trimmed === DEFAULT_SPLIT_PROMPT.trim() ? "" : body.splitPrompt;
    }
    const saved = await savePrompts(patch);
    return {
      globalPrompt: saved.globalPrompt,
      splitPrompt: saved.splitPrompt.trim() || DEFAULT_SPLIT_PROMPT,
    };
  },
);

app.put<{ Body: Partial<Record<ModelEnvKey, string>> }>(
  "/api/settings/model",
  async (request, reply) => {
    const body = request.body ?? {};
    const input: Partial<Record<ModelEnvKey, string>> = {};
    for (const key of MODEL_ENV_KEYS) {
      const value = body[key];
      if (value === undefined || value === null) continue;
      if (typeof value !== "string") {
        return reply.code(400).send({ error: `${key} 必须是字符串` });
      }
      input[key] = value;
    }
    return saveModelSettings(input);
  },
);

app.get("/api/devices", async (_request, reply) => {
  try {
    return await listDevices();
  } catch (error) {
    return reply.code(503).send({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

app.get("/api/cases", async () => listCases());

app.get("/api/stats/executions", async () => getHistoricalExecutionStats());

app.get<{ Querystring: { ids?: string } }>("/api/cases/export", async (request, reply) => {
  const ids = (request.query.ids ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  if (!ids.length) return reply.code(400).send({ error: "请选择要导出的案例" });
  const selected = [];
  for (const id of ids) {
    const existing = await getCase(id);
    if (!existing) return reply.code(404).send({ error: "案例不存在" });
    selected.push(existing);
  }
  const parents = new Map<string, Awaited<ReturnType<typeof getCase>>>();
  for (const item of selected) {
    if (!item.sourceCaseId || parents.has(item.sourceCaseId)) continue;
    parents.set(item.sourceCaseId, await getCase(item.sourceCaseId));
  }
  const buffer = await casesToXlsx(
    selected,
    new Map(
      [...parents.entries()].flatMap(([id, parent]) => (parent ? [[id, parent] as const] : [])),
    ),
  );
  return reply
    .header(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )
    .header("Content-Disposition", 'attachment; filename="cases.xlsx"')
    .send(buffer);
});

app.get<{ Params: { id: string } }>("/api/cases/:id", async (request, reply) => {
  const existing = await getCase(request.params.id);
  if (!existing) return reply.code(404).send({ error: "案例不存在" });
  return existing;
});

app.get<{ Params: { id: string } }>("/api/cases/:id/runs", async (request, reply) => {
  const existing = await getCase(request.params.id);
  if (!existing) return reply.code(404).send({ error: "案例不存在" });
  const runs = await listCaseRunHistory(request.params.id);
  return { caseId: existing.id, caseName: existing.name, runs };
});

app.put<{ Params: { id: string }; Body: CaseUpdateInput }>(
  "/api/cases/:id",
  async (request, reply) => {
    try {
      return await updateCase(request.params.id, request.body ?? {});
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === "案例不存在") return reply.code(404).send({ error: message });
      return reply.code(400).send({ error: message });
    }
  },
);

app.post<{ Body: { text?: string } }>("/api/cases/import", async (request, reply) => {
  const text = request.body?.text?.trim();
  if (!text) return reply.code(400).send({ error: "请输入案例" });
  try {
    const planned = await planNaturalLanguage(text);
    const saved = [];
    for (const item of planned) saved.push(await saveCase(item));
    return { cases: saved };
  } catch (error) {
    return reply.code(400).send({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

app.post<{ Params: { id: string } }>("/api/cases/:id/plan", async (request, reply) => {
  const existing = await getCase(request.params.id);
  if (!existing) return reply.code(404).send({ error: "案例不存在" });
  try {
    const [planned] = await planNaturalLanguage(existing.raw);
    if (!planned) return reply.code(400).send({ error: "没有理解出步骤" });
    // 重新理解只更新步骤；名称与自然语言原文必须保留，避免被模型输出或步骤反推覆盖。
    planned.id = existing.id;
    planned.name = existing.name;
    planned.raw = existing.raw;
    planned.sourceCaseId = existing.sourceCaseId;
    planned.splitOrder = existing.splitOrder;
    planned.packageName = existing.packageName ?? planned.packageName;
    return saveCase(planned);
  } catch (error) {
    return reply.code(400).send({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

app.post<{ Params: { id: string } }>("/api/cases/:id/split", async (request, reply) => {
  try {
    const cases = await splitCase(request.params.id);
    return { cases };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "案例不存在") return reply.code(404).send({ error: message });
    return reply.code(400).send({ error: message });
  }
});

app.delete<{ Params: { id: string } }>("/api/cases/:id", async (request, reply) => {
  try {
    return await removeCaseById(request.params.id);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "案例不存在") return reply.code(404).send({ error: message });
    throw error;
  }
});

app.post<{ Params: { id: string } }>("/api/cases/:id/delete", async (request, reply) => {
  try {
    return await removeCaseById(request.params.id);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "案例不存在") return reply.code(404).send({ error: message });
    throw error;
  }
});

app.post<{ Body: { deviceId?: string; caseIds?: string[] } }>(
  "/api/runs",
  async (request, reply) => {
    try {
      const run = await startRun(
        request.body?.deviceId?.trim() || "",
        request.body?.caseIds ?? [],
      );
      return run;
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
);

app.post<{ Params: { id: string } }>("/api/runs/:id/cancel", async (request, reply) => {
  try {
    return cancelRun(request.params.id);
  } catch (error) {
    return reply.code(400).send({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

app.get<{ Params: { id: string } }>("/api/runs/:id", async (request, reply) => {
  const run = getRun(request.params.id);
  if (!run) return reply.code(404).send({ error: "运行不存在或服务已重启" });
  return run;
});

app.get<{ Params: { id: string } }>("/api/runs/:id/events", async (request, reply) => {
  const run = getRun(request.params.id);
  if (!run) return reply.code(404).send({ error: "运行不存在" });
  reply.hijack();
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const send = (event: Record<string, unknown>) => {
    reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  send({ type: "snapshot", run });
  if (run.finishedAt) send({ type: "done", run });
  const unsubscribe = subscribe(request.params.id, send);
  request.raw.on("close", unsubscribe);
});

function reportForModel(raw: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw.slice(0, 24000);
  }
  const run = parsed as {
    id?: string;
    status?: string;
    summary?: string;
    deviceId?: string;
    globalPrompt?: string;
    cases?: Array<{
      name?: string;
      status?: string;
      conclusion?: string;
      raw?: string;
      steps?: Array<{
        index?: number;
        type?: string;
        instruction?: string;
        status?: string;
        conclusion?: string;
        clickMarks?: Array<{ x?: number; y?: number; description?: string }>;
      }>;
    }>;
  };
  const cases = (run.cases ?? []).map((item) => ({
    name: item.name,
    status: item.status,
    conclusion: item.conclusion,
    raw: item.raw,
    steps: (item.steps ?? []).map((step) => ({
      index: (step.index ?? 0) + 1,
      type: step.type,
      instruction: step.instruction,
      status: step.status,
      conclusion: step.conclusion,
      clicks: (step.clickMarks ?? []).map((mark) => ({
        x: mark.x,
        y: mark.y,
        description: mark.description,
      })),
    })),
  }));
  return JSON.stringify(
    {
      id: run.id,
      status: run.status,
      deviceId: run.deviceId,
      summary: run.summary,
      globalPrompt: run.globalPrompt,
      cases,
    },
    null,
    2,
  );
}

app.get<{ Params: { id: string } }>("/api/runs/:id/report", async (request, reply) => {
  return reply.sendFile("report.html", runDir(request.params.id));
});

app.get<{ Params: { id: string } }>("/api/runs/:id/ask-history", async (request, reply) => {
  const id = request.params.id;
  if (!/^[\w.:-]+$/.test(id)) return reply.code(400).send({ error: "运行编号无效" });
  const messages = await readAskHistory(id);
  return { messages };
});

app.post<{ Params: { id: string }; Body: { messages?: ChatTurn[] } }>(
  "/api/runs/:id/ask",
  async (request, reply) => {
    const id = request.params.id;
    if (!/^[\w.:-]+$/.test(id)) return reply.code(400).send({ error: "运行编号无效" });
    const incoming = request.body?.messages;
    if (!Array.isArray(incoming) || !incoming.length) {
      return reply.code(400).send({ error: "请输入问题" });
    }
    const messages: ChatTurn[] = [];
    for (const turn of incoming.slice(-12)) {
      if (turn?.role !== "user" && turn?.role !== "assistant") {
        return reply.code(400).send({ error: "对话角色无效" });
      }
      if (typeof turn.content !== "string" || !turn.content.trim()) {
        return reply.code(400).send({ error: "对话内容无效" });
      }
      messages.push({ role: turn.role, content: turn.content.trim().slice(0, 4000) });
    }
    if (messages[messages.length - 1]?.role !== "user") {
      return reply.code(400).send({ error: "请先提出问题" });
    }
    let raw = "";
    try {
      raw = await readFile(path.join(runDir(id), "result.json"), "utf8");
    } catch {
      return reply.code(404).send({ error: "这份报告不存在" });
    }
    const system = [
      "你是这次手机自动化测试的复盘助手。用户会把测试报告发给你，并询问为什么某一步出错。",
      "依据报告里的步骤说明、模型结论和 clicks 点击坐标回答。clicks 里的 x、y 是实际触发的截图像素坐标；模型结论是执行时它自己的判断，两者不一致时以坐标为准。",
      "步骤状态是 failed 或写着已终止时，只要 clicks 非空，这些点击就已经发生，不要说成没有执行。",
      "用中文直接回答原因。不要编造报告里没有的界面细节。",
      "测试报告：",
      reportForModel(raw).slice(0, 24000),
    ].join("\n");
    try {
      const answer = await chatMessages(system, messages);
      const saved = [...messages, { role: "assistant" as const, content: answer }];
      await saveAskHistory(id, saved);
      return { answer, messages: saved };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(502).send({ error: message });
    }
  },
);

app.setNotFoundHandler((request, reply) => {
  if (request.url.startsWith("/api/")) {
    return reply.code(404).send({ error: "接口不存在" });
  }
  return reply.sendFile("index.html");
});

await app.listen({ port, host: "127.0.0.1" });
console.log(`控制台 http://127.0.0.1:${port}`);
