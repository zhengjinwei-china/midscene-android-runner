const statusEl = document.querySelector("#status");
const devicesEl = document.querySelector("#devices");
const casesEl = document.querySelector("#cases");
const splitGroupsEl = document.querySelector("#split-groups");
const logEl = document.querySelector("#log");
const reportLink = document.querySelector("#report-link");
const rawEl = document.querySelector("#raw");
const globalPromptEl = document.querySelector("#global-prompt");
const splitPromptEl = document.querySelector("#split-prompt");
const promptMessage = document.querySelector("#prompt-message");
const promptDialog = document.querySelector("#prompt-dialog");

let selectedDevice = "";
let cases = [];
let primaryId = "";
let currentRunId = null;
let currentEventSource = null;
const openSplitGroups = new Set();

const stopRunBtn = document.querySelector("#stop-run");
const caseDialog = document.querySelector("#case-dialog");
const caseForm = document.querySelector("#case-form");
const caseEditName = document.querySelector("#case-edit-name");
const caseEditRaw = document.querySelector("#case-edit-raw");
const caseEditPackage = document.querySelector("#case-edit-package");
const caseEditSteps = document.querySelector("#case-edit-steps");
const caseEditMessage = document.querySelector("#case-edit-message");
const caseEditAddStep = document.querySelector("#case-edit-add-step");

let editingCaseId = null;

const historyDialog = document.querySelector("#history-dialog");
const historyDialogTitle = document.querySelector("#history-dialog-title");
const historyDialogHint = document.querySelector("#history-dialog-hint");
const historyListEl = document.querySelector("#history-list");

const batchOrderDialog = document.querySelector("#batch-order-dialog");
const batchOrderList = document.querySelector("#batch-order-list");
const batchOrderStart = document.querySelector("#batch-order-start");
const batchOrderCancel = document.querySelector("#batch-order-cancel");

const panelOriginal = document.querySelector("#panel-original");
const panelSplit = document.querySelector("#panel-split");
const tabOriginal = document.querySelector("#tab-original");
const tabSplit = document.querySelector("#tab-split");
const historicalExecCountEl = document.querySelector("#historical-exec-count");
const historicalStepCountEl = document.querySelector("#historical-step-count");

function originals() {
  return cases.filter((item) => !item.sourceCaseId);
}

function childrenOf(sourceId) {
  return cases
    .filter((item) => item.sourceCaseId === sourceId)
    .sort((a, b) => (a.splitOrder ?? 0) - (b.splitOrder ?? 0));
}

function showTab(name) {
  const split = name === "split";
  panelOriginal.hidden = split;
  panelSplit.hidden = !split;
  tabOriginal.setAttribute("aria-selected", split ? "false" : "true");
  tabSplit.setAttribute("aria-selected", split ? "true" : "false");
}

async function api(url, options = {}) {
  const headers = { ...options.headers };
  if (options.body !== undefined && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  const response = await fetch(url, { cache: "no-store", ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || response.statusText);
  return data;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function stepsHtml(item) {
  if (!item.steps.length) {
    return `<p class="warn">${escapeHtml(item.planError || "尚未理解成步骤")}</p>`;
  }
  const lines = item.steps
    .map(
      (step) =>
        `<li>${step.type === "action" ? "操作" : "断言"}：${escapeHtml(step.instruction)}${step.skipOnBatchContinue ? ' <span class="muted">(接续跳过)</span>' : ""}</li>`,
    )
    .join("");
  return `<details class="steps-details"><summary>步骤 ${item.steps.length}</summary><ol class="steps">${lines}</ol></details>`;
}

function renderDevices(devices) {
  if (!devices.length) {
    devicesEl.innerHTML = '<p class="muted">没有检测到手机。请用 USB 连接并打开调试，然后点刷新。</p>';
    selectedDevice = "";
    return;
  }
  if (!devices.some((device) => device.udid === selectedDevice)) {
    selectedDevice = devices[0].udid;
  }
  devicesEl.innerHTML = devices
    .map(
      (device) => `<label class="card"><input type="radio" name="device" value="${device.udid}" ${device.udid === selectedDevice ? "checked" : ""}/>
        <span><strong>${escapeHtml(device.brand || "")} ${escapeHtml(device.model || device.udid)}</strong><br/><span class="muted">${escapeHtml(device.udid)} · ${escapeHtml(device.state)}</span></span></label>`,
    )
    .join("");
}

function renderOriginals() {
  const list = originals();
  if (!list.length) {
    casesEl.innerHTML = '<p class="muted">还没有原始案例。</p>';
    return;
  }
  if (!list.some((item) => item.id === primaryId)) primaryId = list[0].id;
  casesEl.innerHTML = list
    .map((item) => {
      const batchSkipCount = (item.steps ?? []).filter((step) => step.skipOnBatchContinue).length;
      const batchSkipHint =
        batchSkipCount > 0
          ? `<p class="muted batch-skip-hint">批量接续时可跳过 ${batchSkipCount} 步</p>`
          : "";
      return `<article class="card" data-case-id="${item.id}">
          <div class="card-head">
            <input type="checkbox" value="${item.id}" ${item.id === primaryId ? "checked" : ""}/>
            <strong class="card-title">${escapeHtml(item.name)}</strong>
          </div>
          ${batchSkipHint}
          <div class="row card-actions">
            <button class="secondary" data-action="rename-case" data-id="${item.id}" type="button">改标题</button>
            <button class="secondary" data-action="edit-case" data-id="${item.id}" type="button">编辑</button>
            <button class="secondary" data-action="split-case" data-id="${item.id}" type="button">拆分</button>
            <button class="secondary" data-action="replan" data-id="${item.id}" type="button">重新理解</button>
            <button class="secondary" data-action="case-history" data-id="${item.id}" type="button">历史报告</button>
            <button class="secondary" data-action="delete-case" data-id="${item.id}" type="button">删除</button>
          </div>
          <pre class="muted">${escapeHtml(item.raw)}</pre>
          ${stepsHtml(item)}
        </article>`;
    })
    .join("");
}

function renderSplitGroups() {
  const sourceIds = [...new Set(cases.filter((item) => item.sourceCaseId).map((item) => item.sourceCaseId))];
  if (!sourceIds.length) {
    splitGroupsEl.innerHTML = '<p class="muted">还没有拆分子案例。在原始案例上点「拆分」。</p>';
    return;
  }
  const byId = new Map(cases.map((item) => [item.id, item]));
  splitGroupsEl.innerHTML = sourceIds
    .map((sourceId) => {
      const parent = byId.get(sourceId);
      const title = parent?.name || "原案例已删除";
      const open = openSplitGroups.has(sourceId) ? "open" : "";
      const rows = childrenOf(sourceId)
        .map(
          (item) => `<div class="split-row">
            <input type="checkbox" value="${item.id}" data-source="${escapeHtml(sourceId)}" />
            <span class="split-order">${item.splitOrder ?? ""}</span>
            <div>
              <strong class="card-title">${escapeHtml(item.name)}</strong>
              <div class="row card-actions">
                <button class="secondary" data-action="rename-case" data-id="${item.id}" type="button">改标题</button>
                <button class="secondary" data-action="edit-case" data-id="${item.id}" type="button">编辑</button>
                <button class="secondary" data-action="case-history" data-id="${item.id}" type="button">历史报告</button>
                <button class="secondary" data-action="delete-case" data-id="${item.id}" type="button">删除</button>
              </div>
              ${stepsHtml(item)}
            </div>
          </div>`,
        )
        .join("");
      return `<section class="split-group">
        <div class="split-group-head">
          <h3 class="split-group-title">${escapeHtml(title)}</h3>
          <div class="row">
            <button class="secondary" type="button" data-action="toggle-group" data-source="${escapeHtml(sourceId)}">${open ? "收起" : "展开"}</button>
            <button class="secondary" type="button" data-action="rename-group" data-source="${escapeHtml(sourceId)}">改组标题</button>
            <button type="button" data-action="run-group" data-source="${escapeHtml(sourceId)}">按顺序执行本组</button>
            <button class="secondary" type="button" data-action="export-group" data-source="${escapeHtml(sourceId)}">导出本组</button>
            <button class="secondary" type="button" data-action="delete-group" data-source="${escapeHtml(sourceId)}">删除本组</button>
          </div>
        </div>
        <div class="split-body" ${open ? "" : "hidden"}>${rows}</div>
      </section>`;
    })
    .join("");
}

function renderCases() {
  renderOriginals();
  renderSplitGroups();
}

function stepEditRowHtml(step = { type: "action", instruction: "" }) {
  const type = step.type === "assert" ? "assert" : "action";
  const batchSkip = step.skipOnBatchContinue ? "checked" : "";
  return `<div class="step-edit-row">
    <select class="step-type" aria-label="步骤类型">
      <option value="action" ${type === "action" ? "selected" : ""}>操作</option>
      <option value="assert" ${type === "assert" ? "selected" : ""}>断言</option>
    </select>
    <input class="step-instruction" type="text" value="${escapeHtml(step.instruction)}" placeholder="步骤说明" />
    <label class="step-batch-skip-label" title="批量执行且本条不是第一条时跳过此步">
      <input type="checkbox" class="step-batch-skip" ${batchSkip} />
      接续跳过
    </label>
    <button type="button" class="secondary step-remove" title="移除此步">删</button>
  </div>`;
}

function renderCaseEditSteps(steps) {
  const list = steps?.length ? steps : [{ type: "action", instruction: "" }];
  caseEditSteps.innerHTML = list.map((step) => stepEditRowHtml(step)).join("");
}

function readCaseEditSteps() {
  return [...caseEditSteps.querySelectorAll(".step-edit-row")]
    .map((row) => {
      const instruction = row.querySelector(".step-instruction")?.value.trim() ?? "";
      const skipOnBatchContinue = Boolean(row.querySelector(".step-batch-skip")?.checked);
      const step = {
        type: row.querySelector(".step-type")?.value === "assert" ? "assert" : "action",
        instruction,
      };
      if (skipOnBatchContinue) step.skipOnBatchContinue = true;
      return step;
    })
    .filter((step) => step.instruction.length > 0);
}

function openCaseEditor(id) {
  const item = cases.find((entry) => entry.id === id);
  if (!item) return;
  editingCaseId = id;
  caseEditMessage.textContent = "";
  caseEditName.value = item.name;
  caseEditRaw.value = item.raw;
  caseEditPackage.value = item.packageName || "";
  renderCaseEditSteps(item.steps);
  caseDialog.showModal();
}

function formatRunTime(iso) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("zh-CN", { hour12: false });
}

function caseStatusLabel(status) {
  if (status === "passed") return "通过";
  if (status === "failed") return "失败";
  if (status === "skipped") return "跳过";
  return "未知";
}

function renderHistoryList(runs) {
  if (!runs.length) {
    historyListEl.innerHTML = '<p class="muted">该案例还没有执行记录。执行一次后这里会出现报告链接。</p>';
    return;
  }
  historyListEl.innerHTML = runs
    .map((run) => {
      const statusClass =
        run.caseStatus === "passed" || run.caseStatus === "failed" ? run.caseStatus : "unknown";
      const link = run.hasReport
        ? `<a href="/runs/${encodeURIComponent(run.runId)}/report.html" target="_blank" rel="noopener">打开报告</a>`
        : `<span class="muted">无 HTML 报告</span>`;
      return `<article class="history-item">
        <div class="history-item-main">
          <span class="history-status ${statusClass}">${caseStatusLabel(run.caseStatus)}</span>
          <span class="history-item-meta"> ${formatRunTime(run.finishedAt || run.startedAt)} · 设备 ${escapeHtml(run.deviceId)} · 任务 ${escapeHtml(run.runStatus)}</span>
          <p class="history-item-conclusion">${escapeHtml(run.conclusion || "（无结论）")}</p>
        </div>
        <div>${link}</div>
      </article>`;
    })
    .join("");
}

async function openCaseHistory(id) {
  const item = cases.find((entry) => entry.id === id);
  historyDialogTitle.textContent = item ? `执行记录 · ${item.name}` : "执行记录";
  historyDialogHint.textContent = "按时间倒序，仅包含本案例曾参与过的运行。";
  historyListEl.innerHTML = '<p class="muted">正在加载…</p>';
  historyDialog.showModal();
  try {
    const data = await api(`/api/cases/${encodeURIComponent(id)}/runs`);
    renderHistoryList(data.runs ?? []);
  } catch (error) {
    historyListEl.innerHTML = `<p class="warn">${escapeHtml(error.message)}</p>`;
  }
}

async function saveCaseEditor() {
  if (!editingCaseId) return;
  caseEditMessage.textContent = "正在保存…";
  const steps = readCaseEditSteps();
  if (!steps.length) {
    caseEditMessage.textContent = "请至少保留一条有内容的执行步骤。";
    return;
  }
  try {
    const body = {
      name: caseEditName.value.trim(),
      raw: caseEditRaw.value.trim(),
      packageName: caseEditPackage.value.trim() || null,
      steps,
    };
    await api(`/api/cases/${encodeURIComponent(editingCaseId)}`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
    caseDialog.close();
    editingCaseId = null;
    await loadCases();
    logEl.textContent = `案例「${body.name}」已保存。`;
  } catch (error) {
    caseEditMessage.textContent = error.message;
  }
}

async function openPromptDialog() {
  promptMessage.textContent = "";
  const settings = await api("/api/settings/prompts");
  globalPromptEl.value = settings.globalPrompt || "";
  splitPromptEl.value = settings.splitPrompt || "";
  promptDialog.showModal();
}

async function savePrompts(event) {
  event.preventDefault();
  promptMessage.textContent = "正在保存…";
  try {
    await api("/api/settings/prompts", {
      method: "PUT",
      body: JSON.stringify({
        globalPrompt: globalPromptEl.value,
        splitPrompt: splitPromptEl.value,
      }),
    });
    promptDialog.close();
    logEl.textContent = "提示词已保存。";
  } catch (error) {
    promptMessage.textContent = error.message;
  }
}

async function loadStatus() {
  const status = await api("/api/status");
  const parts = [];
  parts.push(status.plannerReady ? `案例理解：${status.plannerModel}` : "案例理解：未配置");
  parts.push(
    status.midsceneReady
      ? `手机执行：${status.midsceneModel}（${status.midsceneFamily}）`
      : "手机执行：未配置",
  );
  statusEl.textContent = parts.join(" · ");
}

async function restartServer() {
  const restartBtn = document.querySelector("#restart-server");
  if (!window.confirm("将重新读取 .env 中的模型等配置（不退出后台服务）。有任务在执行时无法加载。继续？")) {
    return;
  }
  restartBtn.disabled = true;
  statusEl.textContent = "正在重新加载 .env…";
  try {
    await api("/api/server/restart", { method: "POST", body: "{}" });
    await loadStatus();
    logEl.textContent = "已重新加载 .env，新配置已生效。";
  } catch (error) {
    logEl.textContent = error.message;
    await loadStatus();
  } finally {
    restartBtn.disabled = false;
  }
}

const systemMenu = document.querySelector("#system-menu");
const systemPanel = document.querySelector("#system-panel");
const modelDialog = document.querySelector("#model-dialog");
const modelForm = document.querySelector("#model-form");
const modelMessage = document.querySelector("#model-message");

function setMenuOpen(open) {
  systemPanel.hidden = !open;
  systemMenu.setAttribute("aria-expanded", open ? "true" : "false");
}

async function loadDevices() {
  try {
    renderDevices(await api("/api/devices"));
  } catch (error) {
    devicesEl.innerHTML = `<p class="warn">${escapeHtml(error.message)}</p>`;
  }
}

async function renameCase(id) {
  const item = cases.find((entry) => entry.id === id);
  if (!item) return;
  const next = window.prompt("案例标题", item.name);
  if (next === null) return;
  const name = next.trim();
  if (!name) {
    logEl.textContent = "案例标题不能为空。";
    return;
  }
  if (name === item.name) return;
  try {
    await api(`/api/cases/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify({ name }),
    });
    await loadCases();
    logEl.textContent = `标题已改为「${name}」。`;
  } catch (error) {
    logEl.textContent = error.message;
  }
}

async function deleteCaseById(id) {
  if (!id) return;
  const item = cases.find((entry) => entry.id === id);
  const label = item?.name || id;
  if (!window.confirm(`确定删除案例「${label}」？此操作不可恢复。`)) return;
  try {
    await api(`/api/cases/${encodeURIComponent(id)}/delete`, { method: "POST", body: "{}" });
    if (primaryId === id) primaryId = "";
    await loadCases();
    logEl.textContent = `已删除案例「${label}」。`;
  } catch (error) {
    logEl.textContent = `删除失败：${error.message}`;
    await loadCases();
  }
}

async function deleteGroup(sourceId) {
  const items = childrenOf(sourceId);
  if (!items.length) return;
  const parent = cases.find((entry) => entry.id === sourceId);
  const label = parent?.name || "该组";
  if (!window.confirm(`确定删除「${label}」拆出的 ${items.length} 条子案例？原案例会保留。`)) return;
  try {
    for (const item of items) {
      await api(`/api/cases/${encodeURIComponent(item.id)}/delete`, { method: "POST", body: "{}" });
    }
    openSplitGroups.delete(sourceId);
    await loadCases();
    logEl.textContent = `已删除「${label}」的拆分子案例。`;
  } catch (error) {
    logEl.textContent = `删除失败：${error.message}`;
    await loadCases();
  }
}

async function loadCases() {
  cases = await api("/api/cases");
  renderCases();
}

async function loadExecutionStats() {
  try {
    const data = await api("/api/stats/executions");
    historicalExecCountEl.textContent = (data.historicalCaseExecutions ?? 0).toLocaleString();
    historicalStepCountEl.textContent = (data.historicalStepExecutions ?? 0).toLocaleString();
  } catch {
    historicalExecCountEl.textContent = "—";
    historicalStepCountEl.textContent = "—";
  }
}

async function splitCase(id) {
  logEl.textContent = "正在让大模型拆分案例…";
  try {
    const data = await api(`/api/cases/${id}/split`, { method: "POST", body: "{}" });
    openSplitGroups.add(id);
    await loadCases();
    showTab("split");
    logEl.textContent = `已拆成 ${data.cases?.length ?? 0} 条子案例，已切到「拆分子案例」。`;
  } catch (error) {
    logEl.textContent = error.message;
  }
}

async function replan(id) {
  logEl.textContent = "正在让大模型理解案例…";
  try {
    await api(`/api/cases/${id}/plan`, { method: "POST", body: "{}" });
    await loadCases();
    logEl.textContent = "案例已重新理解。";
  } catch (error) {
    logEl.textContent = error.message;
  }
}

function checkedOriginalIds() {
  return [...casesEl.querySelectorAll('input[type="checkbox"]:checked')].map((input) => input.value);
}

function checkedSplitIds() {
  const ids = [...splitGroupsEl.querySelectorAll('input[type="checkbox"]:checked')].map(
    (input) => input.value,
  );
  const byId = new Map(cases.map((item) => [item.id, item]));
  return ids.sort((a, b) => {
    const left = byId.get(a);
    const right = byId.get(b);
    const source = (left?.sourceCaseId || "").localeCompare(right?.sourceCaseId || "");
    if (source !== 0) return source;
    return (left?.splitOrder ?? 0) - (right?.splitOrder ?? 0);
  });
}

function caseNameById(id) {
  return cases.find((entry) => entry.id === id)?.name || id;
}

function renderBatchOrderList(orderedIds) {
  batchOrderList.innerHTML = orderedIds
    .map((id, index) => {
      const upDisabled = index === 0 ? "disabled" : "";
      const downDisabled = index === orderedIds.length - 1 ? "disabled" : "";
      return `<li class="batch-order-item" data-id="${id}">
        <span class="batch-order-index">${index + 1}</span>
        <span class="batch-order-name">${escapeHtml(caseNameById(id))}</span>
        <div class="batch-order-move">
          <button type="button" class="secondary batch-order-up" title="上移" ${upDisabled}>↑</button>
          <button type="button" class="secondary batch-order-down" title="下移" ${downDisabled}>↓</button>
        </div>
      </li>`;
    })
    .join("");
}

function batchOrderIdsFromDom() {
  return [...batchOrderList.querySelectorAll(".batch-order-item")].map((row) => row.dataset.id);
}

function moveBatchOrderItem(id, direction) {
  const ids = batchOrderIdsFromDom();
  const index = ids.indexOf(id);
  if (index < 0) return;
  const swapWith = direction === "up" ? index - 1 : index + 1;
  if (swapWith < 0 || swapWith >= ids.length) return;
  [ids[index], ids[swapWith]] = [ids[swapWith], ids[index]];
  renderBatchOrderList(ids);
}

function openBatchOrderDialog(ids) {
  return new Promise((resolve) => {
    renderBatchOrderList(ids);
    const finish = (result) => {
      batchOrderStart.removeEventListener("click", onStart);
      batchOrderCancel.removeEventListener("click", onCancel);
      batchOrderList.removeEventListener("click", onListClick);
      batchOrderDialog.removeEventListener("cancel", onCancel);
      batchOrderDialog.close();
      resolve(result);
    };
    const onStart = () => finish(batchOrderIdsFromDom());
    const onCancel = () => finish(null);
    const onListClick = (event) => {
      const row = event.target.closest(".batch-order-item");
      if (!row) return;
      if (event.target.closest(".batch-order-up:not([disabled])")) moveBatchOrderItem(row.dataset.id, "up");
      if (event.target.closest(".batch-order-down:not([disabled])")) moveBatchOrderItem(row.dataset.id, "down");
    };
    batchOrderStart.addEventListener("click", onStart);
    batchOrderCancel.addEventListener("click", onCancel);
    batchOrderList.addEventListener("click", onListClick);
    batchOrderDialog.addEventListener("cancel", onCancel);
    batchOrderDialog.showModal();
  });
}

function setRunControls(running) {
  stopRunBtn.disabled = !running;
  for (const id of ["#run-one", "#run-batch", "#run-split-checked"]) {
    document.querySelector(id).disabled = running;
  }
}

function finishRun(run) {
  currentRunId = null;
  setRunControls(false);
  if (currentEventSource) {
    currentEventSource.close();
    currentEventSource = null;
  }
  logEl.textContent += `\n${run.summary}\n`;
  if (run.tokenUsage?.total) {
    logEl.textContent += `本次 Token 用量（估算）：约 ${run.tokenUsage.total.toLocaleString()}（详见测试报告）\n`;
  }
  reportLink.innerHTML = `<a href="/runs/${run.id}/report.html" target="_blank">打开测试报告</a>`;
  void loadExecutionStats();
}

async function run(caseIds) {
  reportLink.textContent = "";
  if (!selectedDevice) {
    logEl.textContent = "请先连接手机并选择设备。";
    return;
  }
  logEl.textContent = "开始执行…\n";
  const runRecord = await api("/api/runs", {
    method: "POST",
    body: JSON.stringify({ deviceId: selectedDevice, caseIds }),
  });
  currentRunId = runRecord.id;
  setRunControls(true);
  const source = new EventSource(`/api/runs/${runRecord.id}/events`);
  currentEventSource = source;
  source.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.type === "snapshot" && data.run.summary) logEl.textContent += `${data.run.summary}\n`;
    if (data.type === "step") {
      logEl.textContent += `案例 ${data.caseId} 步骤 ${data.index + 1}：${data.instruction}\n`;
    }
    if (data.type === "step-done") logEl.textContent += `  ${data.step.status}：${data.step.conclusion}\n`;
    if (data.type === "done") finishRun(data.run);
  };
  source.onerror = () => {
    if (currentEventSource) currentEventSource.close();
    currentEventSource = null;
  };
}

async function exportCases(ids) {
  if (!ids.length) {
    logEl.textContent = "请勾选要导出的案例。";
    return;
  }
  try {
    const response = await fetch(`/api/cases/export?ids=${encodeURIComponent(ids.join(","))}`);
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || `请求失败 ${response.status}`);
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "cases.xlsx";
    link.click();
    URL.revokeObjectURL(url);
    logEl.textContent = `已导出 ${ids.length} 条案例。`;
  } catch (error) {
    logEl.textContent = error.message;
  }
}

devicesEl.addEventListener("change", (event) => {
  const input = event.target.closest('input[name="device"]');
  if (input) selectedDevice = input.value;
});

casesEl.addEventListener("change", (event) => {
  const input = event.target.closest('input[type="checkbox"]');
  if (input?.checked) primaryId = input.value;
});

casesEl.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  event.preventDefault();
  const id = button.dataset.id;
  const action = button.dataset.action;
  if (action === "rename-case") void renameCase(id);
  if (action === "edit-case") openCaseEditor(id);
  if (action === "split-case") void splitCase(id);
  if (action === "replan") void replan(id);
  if (action === "case-history") void openCaseHistory(id);
  if (action === "delete-case") void deleteCaseById(id);
});

splitGroupsEl.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  event.preventDefault();
  const action = button.dataset.action;
  const id = button.dataset.id;
  const sourceId = button.dataset.source;
  if (action === "rename-case") void renameCase(id);
  if (action === "edit-case") openCaseEditor(id);
  if (action === "case-history") void openCaseHistory(id);
  if (action === "delete-case") void deleteCaseById(id);
  if (action === "rename-group") {
    const parent = cases.find((entry) => entry.id === sourceId);
    if (!parent) {
      logEl.textContent = "原案例已删除，无法修改组标题。";
      return;
    }
    void renameCase(parent.id);
  }
  if (action === "toggle-group") {
    if (openSplitGroups.has(sourceId)) openSplitGroups.delete(sourceId);
    else openSplitGroups.add(sourceId);
    renderSplitGroups();
  }
  if (action === "run-group") {
    const ids = childrenOf(sourceId).map((item) => item.id);
    if (!ids.length) return;
    void run(ids).catch((error) => {
      logEl.textContent = error.message;
    });
  }
  if (action === "export-group") void exportCases(childrenOf(sourceId).map((item) => item.id));
  if (action === "delete-group") void deleteGroup(sourceId);
});

tabOriginal.addEventListener("click", () => showTab("original"));
tabSplit.addEventListener("click", () => showTab("split"));

document.querySelector("#open-prompts").addEventListener("click", () => {
  void openPromptDialog();
});
document.querySelector("#prompt-form").addEventListener("submit", (event) => {
  void savePrompts(event);
});
document.querySelector("#close-prompts").addEventListener("click", () => promptDialog.close());

systemMenu.addEventListener("click", () => setMenuOpen(systemPanel.hidden));
document.addEventListener("click", (event) => {
  if (!event.target.closest(".menu")) setMenuOpen(false);
});

document.querySelector("#open-model").addEventListener("click", async () => {
  setMenuOpen(false);
  modelMessage.textContent = "";
  const settings = await api("/api/settings/model");
  modelForm.PLANNER_MODEL_BASE_URL.value = settings.planner.baseUrl;
  modelForm.PLANNER_MODEL_NAME.value = settings.planner.model;
  modelForm.PLANNER_MODEL_API_KEY.value = "";
  modelForm.PLANNER_MODEL_API_KEY.placeholder = settings.planner.apiKeySet
    ? "已保存，留空则不修改"
    : "必填后才能理解案例";
  modelForm.MIDSCENE_MODEL_BASE_URL.value = settings.midscene.baseUrl;
  modelForm.MIDSCENE_MODEL_NAME.value = settings.midscene.model;
  modelForm.MIDSCENE_MODEL_FAMILY.value = settings.midscene.family;
  modelForm.MIDSCENE_MODEL_API_KEY.value = "";
  modelForm.MIDSCENE_MODEL_API_KEY.placeholder = settings.midscene.apiKeySet
    ? "已保存，留空则不修改"
    : "必填后才能在手机上执行";
  modelDialog.showModal();
});

document.querySelector("#close-model").addEventListener("click", () => modelDialog.close());
document.querySelector("#close-case").addEventListener("click", () => {
  caseDialog.close();
  editingCaseId = null;
});
document.querySelector("#close-history").addEventListener("click", () => historyDialog.close());

caseEditAddStep.addEventListener("click", () => {
  caseEditSteps.insertAdjacentHTML("beforeend", stepEditRowHtml());
});
caseEditSteps.addEventListener("click", (event) => {
  const removeBtn = event.target.closest(".step-remove");
  if (!removeBtn) return;
  const row = removeBtn.closest(".step-edit-row");
  if (!row) return;
  if (caseEditSteps.querySelectorAll(".step-edit-row").length <= 1) {
    row.querySelector(".step-instruction").value = "";
    row.querySelector(".step-type").value = "action";
    return;
  }
  row.remove();
});
caseForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void saveCaseEditor();
});
modelForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const body = Object.fromEntries(new FormData(modelForm).entries());
  try {
    await api("/api/settings/model", { method: "PUT", body: JSON.stringify(body) });
    modelDialog.close();
    await loadStatus();
  } catch (error) {
    modelMessage.textContent = error.message;
  }
});

stopRunBtn.addEventListener("click", async () => {
  if (!currentRunId) return;
  stopRunBtn.disabled = true;
  logEl.textContent += "\n正在终止，请等待当前步骤结束…\n";
  try {
    await api(`/api/runs/${currentRunId}/cancel`, { method: "POST", body: "{}" });
  } catch (error) {
    logEl.textContent += `${error.message}\n`;
    stopRunBtn.disabled = false;
  }
});

document.querySelector("#restart-server").addEventListener("click", () => {
  void restartServer();
});
document.querySelector("#refresh").addEventListener("click", () => {
  void loadDevices();
});
document.querySelector("#import").addEventListener("click", async () => {
  try {
    logEl.textContent = "正在理解并保存…";
    await api("/api/cases/import", {
      method: "POST",
      body: JSON.stringify({ text: rawEl.value }),
    });
    rawEl.value = "";
    await loadCases();
    logEl.textContent = "已保存。若已配置模型，步骤会显示在案例下方。";
  } catch (error) {
    logEl.textContent = error.message;
  }
});
document.querySelector("#run-one").addEventListener("click", async () => {
  const ids = checkedOriginalIds();
  const id = ids[0] || primaryId;
  if (!id) return;
  try {
    await run([id]);
  } catch (error) {
    logEl.textContent = error.message;
  }
});
document.querySelector("#run-batch").addEventListener("click", async () => {
  const ids = checkedOriginalIds();
  if (!ids.length) {
    logEl.textContent = "请勾选要批量执行的案例。";
    return;
  }
  const orderedIds = await openBatchOrderDialog(ids);
  if (!orderedIds?.length) return;
  try {
    await run(orderedIds);
  } catch (error) {
    logEl.textContent = error.message;
  }
});
document.querySelector("#run-split-checked").addEventListener("click", async () => {
  const ids = checkedSplitIds();
  if (!ids.length) {
    logEl.textContent = "请勾选要执行的子案例。";
    return;
  }
  try {
    await run(ids);
  } catch (error) {
    logEl.textContent = error.message;
  }
});
document.querySelector("#export-split-checked").addEventListener("click", () => {
  void exportCases(checkedSplitIds());
});

await loadStatus();
await loadDevices();
await loadCases();
await loadExecutionStats();
