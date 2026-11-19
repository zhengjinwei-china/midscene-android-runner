import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ChatTurn } from "./llm.js";
import type { RunRecord } from "./types.js";

const ASK_SAVED_RE =
  /(<script type="application\/json" id="ask-saved">)[\s\S]*?(<\/script>)/;

export async function readAskHistory(runId: string): Promise<ChatTurn[]> {
  const dir = runDir(runId);
  try {
    const raw = await readFile(path.join(dir, "ask-history.json"), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (turn): turn is ChatTurn =>
        turn != null &&
        typeof turn === "object" &&
        (turn.role === "user" || turn.role === "assistant") &&
        typeof turn.content === "string",
    );
  } catch {
    try {
      const raw = await readFile(path.join(dir, "result.json"), "utf8");
      const run = JSON.parse(raw) as RunRecord;
      return run.askChat ?? [];
    } catch {
      return [];
    }
  }
}

export async function saveAskHistory(runId: string, turns: ChatTurn[]): Promise<void> {
  const dir = runDir(runId);
  await writeFile(path.join(dir, "ask-history.json"), JSON.stringify(turns, null, 2));
  try {
    const raw = await readFile(path.join(dir, "result.json"), "utf8");
    const run = JSON.parse(raw) as RunRecord;
    run.askChat = turns;
    await writeFile(path.join(dir, "result.json"), JSON.stringify(run, null, 2));
  } catch {
    /* 报告目录不完整时忽略 */
  }
  await syncAskHistoryToReport(runId, turns);
}

export async function syncAskHistoryToReport(runId: string, turns: ChatTurn[]): Promise<void> {
  const file = path.join(runDir(runId), "report.html");
  let html: string;
  try {
    html = await readFile(file, "utf8");
  } catch {
    return;
  }
  if (!ASK_SAVED_RE.test(html)) return;
  const json = JSON.stringify(turns).replaceAll("<", "\\u003c");
  html = html.replace(ASK_SAVED_RE, `$1${json}$2`);
  await writeFile(file, html);
}

export function runDir(runId: string) {
  return path.resolve("data/runs", runId);
}

function renderClickShot(step: RunRecord["cases"][number]["steps"][number]) {
  const marks = step.clickMarks ?? [];
  if (!marks.length) return "";
  const lines = marks
    .map((mark, index) => {
      const size =
        mark.shotWidth && mark.shotHeight
          ? `，画面 ${mark.shotWidth}×${mark.shotHeight}`
          : "";
      const label = mark.description ? escapeHtml(mark.description) : "未命名目标";
      return `<li>第 ${index + 1} 下：${label}，截图像素 (${Math.round(mark.x)}, ${Math.round(mark.y)})${size}</li>`;
    })
    .join("");
  const figures = marks
    .map((mark, index) => {
      const src = mark.screenshot ?? (index === 0 ? step.clickScreenshot : undefined);
      if (!src) return "";
      return `<figure>
        <img src="${escapeHtml(src)}" alt="第 ${index + 1} 次点击，坐标 (${Math.round(mark.x)}, ${Math.round(mark.y)})" />
        <figcaption class="muted">第 ${index + 1} 次点击，红圈在截图像素 (${Math.round(mark.x)}, ${Math.round(mark.y)})</figcaption>
      </figure>`;
    })
    .join("");
  return `<p class="muted">点击坐标</p><ul>${lines}</ul>${figures}`;
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export async function writeReport(run: RunRecord) {
  const dir = runDir(run.id);
  await mkdir(dir, { recursive: true });
  const askChat = run.askChat?.length ? run.askChat : await readAskHistory(run.id);
  if (askChat.length) run = { ...run, askChat };
  await writeFile(path.join(dir, "result.json"), JSON.stringify(run, null, 2));
  const askSavedJson = JSON.stringify(askChat).replaceAll("<", "\\u003c");

  const passed = run.cases.filter((item) => item.status === "passed").length;
  const failed = run.cases.filter((item) => item.status === "failed").length;
  const usage = run.tokenUsage;
  const usageHtml = usage
    ? `<section class="usage">
        <h2>本次执行 Token 用量（估算）</h2>
        <p class="muted">非厂商账单，仅供对比不同案例的大致成本；视觉步按每步约 4.5k tokens 估算。</p>
        <ul>
          <li>文本类（提示词 + 步骤说明 + 系统开销）：约 <strong>${usage.midsceneText.toLocaleString()}</strong> tokens</li>
          <li>视觉类（截图多轮推理）：约 <strong>${usage.midsceneVision.toLocaleString()}</strong> tokens</li>
          <li>合计：约 <strong>${usage.total.toLocaleString()}</strong> tokens（${usage.stepsRun} 个已执行步骤）</li>
        </ul>
        <p class="muted">${escapeHtml(usage.detail)}</p>
      </section>`
    : "";
  const casesHtml = run.cases
    .map((item) => {
      const steps = item.steps
        .map((step) => {
          const shot = step.screenshot
            ? `<figure><img src="${escapeHtml(step.screenshot)}" alt="步骤 ${step.index + 1} 操作后截图" /><figcaption class="muted">操作后</figcaption></figure>`
            : "<p class=\"muted\">这一步没有操作后截图</p>";
          return `<article class="step ${step.status}">
            <header><span>步骤 ${step.index + 1} · ${step.type === "action" ? "操作" : "断言"}</span><strong>${step.status === "passed" ? "通过" : step.status === "failed" ? "失败" : "跳过"}</strong></header>
            <p>${escapeHtml(step.instruction)}</p>
            <p class="conclusion">${escapeHtml(step.conclusion)}</p>
            <p class="muted">${step.durationMs} ms</p>
            ${renderClickShot(step)}
            ${shot}
          </article>`;
        })
        .join("");
      return `<section class="case ${item.status}">
        <h2>${escapeHtml(item.name)} · ${item.status === "passed" ? "通过" : item.status === "skipped" ? "跳过" : "失败"}</h2>
        <p>${escapeHtml(item.conclusion)}</p>
        <pre>${escapeHtml(item.raw)}</pre>
        ${steps}
      </section>`;
    })
    .join("");

  const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>测试报告 ${escapeHtml(run.id)}</title>
  <style>
    body { font-family: "Segoe UI", sans-serif; margin: 32px auto; max-width: 960px; color: #1c1917; background: #faf7f2; }
    h1 { font-size: 28px; }
    .meta { color: #57534e; }
    .case, .step { background: white; border: 1px solid #e7e5e4; border-radius: 12px; padding: 16px; margin: 16px 0; }
    .passed strong, .passed h2 { color: #166534; }
    .failed strong, .failed h2 { color: #991b1b; }
    figure { margin: 12px 0; }
    figcaption { margin-top: 6px; }
    img { width: 100%; max-width: 420px; border-radius: 8px; border: 1px solid #e7e5e4; display: block; }
    .shot-wrap { position: relative; display: inline-block; max-width: 420px; width: 100%; }
    .shot-wrap img { max-width: none; width: 100%; }
    .tap {
      position: absolute;
      width: 18px;
      height: 18px;
      margin: 0;
      border: 3px solid #dc2626;
      border-radius: 50%;
      background: rgba(220, 38, 38, 0.25);
      transform: translate(-50%, -50%);
      box-shadow: 0 0 0 2px #fff;
    }
    pre { white-space: pre-wrap; background: #f5f5f4; padding: 12px; border-radius: 8px; }
    .conclusion { font-weight: 600; }
    .muted { color: #78716c; font-size: 13px; }
    .usage { background: white; border: 1px solid #e7e5e4; border-radius: 12px; padding: 16px; margin: 16px 0; }
    .usage ul { margin: 8px 0; padding-left: 20px; }
    .ask { background: white; border: 1px solid #e7e5e4; border-radius: 12px; padding: 16px; margin: 24px 0 48px; }
    .ask h2 { margin-top: 0; font-size: 20px; }
    .thread { display: flex; flex-direction: column; gap: 10px; margin: 12px 0; }
    .bubble { padding: 10px 12px; border-radius: 10px; white-space: pre-wrap; line-height: 1.5; }
    .bubble.user { background: #f5f5f4; }
    .bubble.assistant { background: #ecfdf3; border: 1px solid #bbf7d0; }
    .ask-row { display: flex; gap: 8px; align-items: flex-end; }
    .ask textarea { flex: 1; min-height: 72px; border: 1px solid #d6d3d1; border-radius: 8px; padding: 8px; font: inherit; }
    .ask button { border: 0; background: #1c1917; color: white; border-radius: 8px; padding: 10px 14px; cursor: pointer; }
    .ask button:disabled { opacity: 0.5; cursor: default; }
  </style>
</head>
<body data-run-id="${escapeHtml(run.id)}">
  <h1>测试报告</h1>
  <p class="meta">设备 ${escapeHtml(run.deviceId)} · ${escapeHtml(run.startedAt)} → ${escapeHtml(run.finishedAt ?? "")}</p>
  <p>通过 ${passed}，失败 ${failed}${run.status === "cancelled" ? "，已终止" : ""}。${escapeHtml(run.summary)}</p>
  ${usageHtml}
  ${run.midsceneReport ? `<p class="meta">Midscene 原始报告：${escapeHtml(run.midsceneReport)}</p>` : ""}
  ${casesHtml}
  <section class="ask">
    <h2>询问这次执行</h2>
    <p class="muted">问题会连同本份报告的步骤、结论和点击落点一起发给当前配置的大模型，回答显示在下面；对话会保存在本报告与 result.json 中，刷新页面后仍可见。</p>
    <div class="thread" id="ask-thread"></div>
    <script type="application/json" id="ask-saved">${askSavedJson}</script>
    <div class="ask-row">
      <textarea id="ask-input" placeholder="例如：为什么首页要点成付款码，而不是充值？"></textarea>
      <button type="button" id="ask-send">发送</button>
    </div>
    <p class="muted" id="ask-error"></p>
  </section>
  <script>
    const runId = document.body.dataset.runId;
    const thread = document.querySelector("#ask-thread");
    const input = document.querySelector("#ask-input");
    const send = document.querySelector("#ask-send");
    const errorEl = document.querySelector("#ask-error");
    const savedEl = document.querySelector("#ask-saved");
    const history = savedEl ? JSON.parse(savedEl.textContent || "[]") : [];

    function addBubble(role, text) {
      const node = document.createElement("div");
      node.className = "bubble " + role;
      node.textContent = (role === "user" ? "我：" : "模型：") + text;
      thread.appendChild(node);
      node.scrollIntoView({ block: "nearest" });
    }

    (async function restoreThread() {
      if (!history.length && runId) {
        try {
          const response = await fetch("/api/runs/" + encodeURIComponent(runId) + "/ask-history");
          if (response.ok) {
            const data = await response.json();
            if (Array.isArray(data.messages)) {
              history.splice(0, history.length, ...data.messages);
            }
          }
        } catch {
          /* 离线打开报告时忽略 */
        }
      }
      for (const turn of history) {
        if (turn?.role && turn?.content) addBubble(turn.role, turn.content);
      }
    })();

    send.addEventListener("click", async () => {
      const text = input.value.trim();
      if (!text) return;
      errorEl.textContent = "";
      send.disabled = true;
      addBubble("user", text);
      history.push({ role: "user", content: text });
      input.value = "";
      try {
        const response = await fetch("/api/runs/" + encodeURIComponent(runId) + "/ask", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: history }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "请求失败");
        history.push({ role: "assistant", content: data.answer });
        addBubble("assistant", data.answer);
      } catch (error) {
        history.pop();
        thread.lastElementChild?.remove();
        input.value = text;
        errorEl.textContent = error instanceof Error ? error.message : String(error);
      } finally {
        send.disabled = false;
        input.focus();
      }
    });
  </script>
</body>
</html>`;
  await writeFile(path.join(dir, "report.html"), html);
  return path.join(dir, "report.html");
}
