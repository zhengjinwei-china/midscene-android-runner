import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { promisify } from "node:util";
import {
  AndroidAgent,
  AndroidDevice,
  getConnectedDevicesWithDetails,
} from "@midscene/android";
import { getCase } from "./cases.js";
import { runDir, writeReport } from "./report.js";
import { refreshMidsceneModelEnv } from "./midscene-env.js";
import { RunCancelledError } from "./run-cancel.js";
import { getAppSettings } from "./settings.js";
import { estimateRunTokenUsage } from "./token-estimate.js";
import type {
  CaseResult,
  ClickMark,
  DeviceInfo,
  RunRecord,
  StepResult,
} from "./types.js";

const execFileAsync = promisify(execFile);

/** 建行生活固定包名：打开该应用时用 adb 冷启动，不交给 aiAct 点桌面图标。 */
const CCB_LONGJI_LIFE_PACKAGE = "com.ccb.longjiLife";

/** 冷启动后等待首屏/闪屏结束（不依赖模型自觉等待）。 */
const COLD_START_SETTLE_MS = 5000;

/** 每次页面跳转类操作（aiAct）后等待加载。 */
const AFTER_ACTION_SETTLE_MS = 5000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type AndroidDeviceOptions = NonNullable<
  ConstructorParameters<typeof AndroidDevice>[1]
>;

/**
 * 三星 + 中文场景：yadb 逐字输入、延后收键盘，减轻 WebView 搜索框丢字和反复点剪贴板条。
 * 非三星仍保留中文友好的 sequential 输入，避免拖慢纯英文场景。
 */
function androidDeviceOptionsForRun(brand?: string): AndroidDeviceOptions {
  const isSamsung = /^samsung$/i.test(brand?.trim() ?? "");
  if (isSamsung) {
    return {
      imeStrategy: "always-yadb",
      inputStrategy: "sequential",
      keyboardTypeDelay: 100,
      autoDismissKeyboard: false,
      keyboardDismissStrategy: "back-first",
    };
  }
  return {
    imeStrategy: "yadb-for-non-ascii",
    inputStrategy: "sequential",
    keyboardTypeDelay: 80,
    autoDismissKeyboard: false,
  };
}

async function deviceBrandForRun(deviceId: string): Promise<string | undefined> {
  try {
    const devices = await getConnectedDevicesWithDetails();
    return devices.find((device) => device.udid === deviceId)?.brand;
  } catch {
    return undefined;
  }
}

type Listener = (event: Record<string, unknown>) => void;

const runs = new Map<string, RunRecord>();
const listeners = new Map<string, Set<Listener>>();
let activeRunId: string | null = null;
let cancelRequested = false;
let activeAgent: AndroidAgent | null = null;

function isRunCancelled(runId: string) {
  return cancelRequested && activeRunId === runId;
}

export function cancelRun(runId: string) {
  if (activeRunId !== runId) {
    throw new Error("该任务不在执行中，无法终止");
  }
  cancelRequested = true;
  void activeAgent?.destroy().catch(() => {});
  return { ok: true };
}

export function getActiveRunId() {
  return activeRunId;
}

export function getRun(id: string) {
  return runs.get(id) ?? null;
}

export function subscribe(id: string, listener: Listener) {
  const set = listeners.get(id) ?? new Set();
  set.add(listener);
  listeners.set(id, set);
  return () => set.delete(listener);
}

function emit(id: string, event: Record<string, unknown>) {
  for (const listener of listeners.get(id) ?? []) listener(event);
}

export async function listDevices(): Promise<DeviceInfo[]> {
  let devices: Awaited<ReturnType<typeof getConnectedDevicesWithDetails>>;
  try {
    devices = await getConnectedDevicesWithDetails();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("adb") && message.toLowerCase().includes("not found")) {
      throw new Error("找不到 adb。请安装 Android 平台工具并加入 PATH。");
    }
    throw new Error("读取手机列表失败。请确认 adb 可用，且手机已打开 USB 调试。");
  }
  return devices.map((device) => ({
    udid: device.udid,
    state: device.state,
    model: device.model,
    brand: device.brand,
  }));
}

async function packageInstalled(serial: string, packageName: string) {
  try {
    const { stdout } = await execFileAsync("adb", [
      "-s",
      serial,
      "shell",
      "pm",
      "path",
      packageName,
    ]);
    return stdout.includes("package:");
  } catch {
    return false;
  }
}

function assertValidPackageName(packageName: string) {
  if (!/^[A-Za-z][\w.]*$/.test(packageName)) {
    throw new Error("包名不合法");
  }
}

function caseTextBlob(testCase: {
  name: string;
  raw: string;
  steps: { instruction: string }[];
}) {
  return [testCase.name, testCase.raw, ...testCase.steps.map((s) => s.instruction)].join(
    "\n",
  );
}

function mentionsCcbLongjiLife(text: string) {
  return text.includes("建行生活");
}

/** 案例或步骤里出现建行生活时，用固定包名启动。 */
function resolveCasePackageName(testCase: {
  packageName?: string;
  name: string;
  raw: string;
  steps: { instruction: string }[];
}): string | undefined {
  if (testCase.packageName?.trim()) return testCase.packageName.trim();
  if (mentionsCcbLongjiLife(caseTextBlob(testCase))) {
    return CCB_LONGJI_LIFE_PACKAGE;
  }
  return undefined;
}

/** 「打开建行生活」类操作走 adb 冷启动，避免点错桌面图标。 */
function isOpenCcbLongjiLifeAction(instruction: string) {
  if (!mentionsCcbLongjiLife(instruction)) return false;
  return /打开|启动|进入\s*(app|应用)?/i.test(instruction);
}

/** 同一句里除了打开应用，还有点击、输入等后续操作。 */
function actionContinuesAfterLaunch(instruction: string) {
  return /点击|点按|输入|滑动|上滑|下滑|左滑|右滑|长按|搜索|勾选|选择|切换|返回/.test(
    instruction,
  );
}

async function stopPackage(serial: string, packageName: string) {
  assertValidPackageName(packageName);
  try {
    await execFileAsync("adb", [
      "-s",
      serial,
      "shell",
      "am",
      "force-stop",
      packageName,
    ]);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`adb 结束「${packageName}」失败：${detail}`);
  }
}

async function launchPackage(serial: string, packageName: string) {
  assertValidPackageName(packageName);
  if (!(await packageInstalled(serial, packageName))) {
    throw new Error(
      `手机上未安装应用包「${packageName}」。请用 adb shell pm list packages 查正确包名，或删掉案例里的包名后点「重新理解」。`,
    );
  }
  try {
    await execFileAsync("adb", [
      "-s",
      serial,
      "shell",
      "monkey",
      "-p",
      packageName,
      "-c",
      "android.intent.category.LAUNCHER",
      "1",
    ]);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`adb 启动「${packageName}」失败：${detail}`);
  }
}

async function coldStartPackage(serial: string, packageName: string) {
  await stopPackage(serial, packageName);
  await launchPackage(serial, packageName);
  await sleep(COLD_START_SETTLE_MS);
}

type CollectedClick = ClickMark & { imageBase64?: string };

function screenshotBase64FromUi(shot: unknown): string | undefined {
  if (!shot || typeof shot !== "object") return undefined;
  const base64 = (shot as { base64?: unknown }).base64;
  return typeof base64 === "string" && base64.length > 100 ? base64 : undefined;
}

function collectClickMarks(
  agent: AndroidAgent,
  dumpStart: number,
): CollectedClick[] {
  const executions = agent.dump?.executions ?? [];
  const marks: CollectedClick[] = [];
  for (const execution of executions.slice(dumpStart)) {
    let shotWidth: number | undefined;
    let shotHeight: number | undefined;
    let imageBase64: string | undefined;
    for (const task of execution.tasks ?? []) {
      const shot = task.uiContext?.shotSize;
      if (shot?.width && shot?.height) {
        shotWidth = shot.width;
        shotHeight = shot.height;
      }
      const fromUi = screenshotBase64FromUi(task.uiContext?.screenshot);
      if (fromUi) imageBase64 = fromUi;
      if (task.type !== "Action Space" || task.subType !== "Tap") continue;
      const locate = task.param?.locate;
      const center = locate?.center;
      if (!Array.isArray(center) || center.length < 2) continue;
      const x = Number(center[0]);
      const y = Number(center[1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      marks.push({
        x,
        y,
        shotWidth,
        shotHeight,
        description:
          typeof locate.description === "string" ? locate.description : undefined,
        imageBase64,
      });
    }
  }
  return marks;
}

function clickConclusion(marks: ClickMark[]) {
  return marks
    .map((mark, index) => {
      const label = mark.description ? `「${mark.description}」` : "未命名目标";
      return `第 ${index + 1} 下 ${label}，截图像素 (${Math.round(mark.x)}, ${Math.round(mark.y)})`;
    })
    .join("；");
}

async function drawClickMarks(base64: string, marks: ClickMark[]) {
  const input = screenshotBase64ToBuffer(base64);
  const image = sharp(input);
  const meta = await image.metadata();
  const width = meta.width ?? marks[0]?.shotWidth ?? 0;
  const height = meta.height ?? marks[0]?.shotHeight ?? 0;
  if (!width || !height || !marks.length) return base64;
  const circles = marks
    .map((mark) => {
      const x = mark.shotWidth ? (mark.x / mark.shotWidth) * width : mark.x;
      const y = mark.shotHeight ? (mark.y / mark.shotHeight) * height : mark.y;
      const radius = Math.max(28, Math.round(width * 0.028));
      return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${radius}" fill="rgba(220,38,38,0.28)" stroke="#dc2626" stroke-width="${Math.max(6, Math.round(radius / 5))}"/>`;
    })
    .join("");
  const svg = Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">${circles}</svg>`,
  );
  const png = await image
    .composite([{ input: svg, top: 0, left: 0 }])
    .png()
    .toBuffer();
  return `data:image/png;base64,${png.toString("base64")}`;
}

function screenshotBase64ToBuffer(base64: string): Buffer {
  const trimmed = base64.trim();
  const dataUri = trimmed.match(/^data:image\/(?:png|jpe?g);base64,(.+)$/is);
  const body = (dataUri ? dataUri[1] : trimmed).replace(/\s/g, "");
  return Buffer.from(body, "base64");
}

async function saveShot(runId: string, fileName: string, base64: string) {
  const dir = path.join(runDir(runId), "shots");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, fileName), screenshotBase64ToBuffer(base64));
  return `shots/${fileName}`;
}

/** 同一批执行内共享：首个需拉起的案例冷启动后，后续不再杀进程重开。 */
interface RunBatchState {
  appColdStartedInBatch: boolean;
}

const BATCH_CONTINUE_SKIP_REASON =
  "批量接续：沿用上一案例结束界面，跳过本步";

function shouldSkipStepOnBatchContinue(
  testCase: { steps: { length: number }; batchSkipSteps?: number },
  step: { skipOnBatchContinue?: boolean },
  index: number,
  caseIndexInRun: number,
) {
  if (caseIndexInRun <= 0) return false;
  if (step.skipOnBatchContinue) return true;
  const legacy = testCase.batchSkipSteps ?? 0;
  if (legacy > 0 && index < Math.min(Math.floor(legacy), testCase.steps.length)) {
    return true;
  }
  return false;
}

async function runCase(
  run: RunRecord,
  agent: AndroidAgent,
  device: AndroidDevice,
  caseId: string,
  batch: RunBatchState,
  caseIndexInRun: number,
): Promise<CaseResult> {
  const testCase = await getCase(caseId);
  const startedAt = new Date().toISOString();
  if (!testCase) {
    return {
      caseId,
      name: caseId,
      raw: "",
      status: "failed",
      conclusion: "案例不存在",
      steps: [],
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }
  if (!testCase.steps.length) {
    return {
      caseId,
      name: testCase.name,
      raw: testCase.raw,
      status: "failed",
      conclusion: testCase.planError || "案例还没有被理解成可执行步骤",
      steps: [],
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }

  const launchPackageName = resolveCasePackageName(testCase);
  const steps: StepResult[] = [];
  let failed = false;
  let cancelled = false;
  const pushSkipped = (fromIndex: number, reason: string) => {
    for (let index = fromIndex; index < testCase.steps.length; index += 1) {
      const skipped = testCase.steps[index]!;
      steps.push({
        index,
        type: skipped.type,
        instruction: skipped.instruction,
        status: "skipped",
        conclusion: reason,
        durationMs: 0,
      });
    }
  };

  let coldStartedThisCase = false;
  if (launchPackageName && !batch.appColdStartedInBatch) {
    await coldStartPackage(run.deviceId, launchPackageName);
    coldStartedThisCase = true;
    batch.appColdStartedInBatch = true;
  }

  for (let index = 0; index < testCase.steps.length; index += 1) {
    if (isRunCancelled(run.id)) {
      cancelled = true;
      pushSkipped(index, "执行已终止，已跳过");
      break;
    }
    const step = testCase.steps[index]!;
    if (shouldSkipStepOnBatchContinue(testCase, step, index, caseIndexInRun)) {
      steps.push({
        index,
        type: step.type,
        instruction: step.instruction,
        status: "skipped",
        conclusion: BATCH_CONTINUE_SKIP_REASON,
        durationMs: 0,
      });
      continue;
    }
    if (failed) {
      steps.push({
        index,
        type: step.type,
        instruction: step.instruction,
        status: "skipped",
        conclusion: "前序步骤失败，已跳过",
        durationMs: 0,
      });
      continue;
    }

    emit(run.id, {
      type: "step",
      caseId,
      index,
      instruction: step.instruction,
    });
    const started = Date.now();
    let status: StepResult["status"] = "passed";
    let conclusion = step.type === "assert" ? "断言通过" : "操作已完成";
    let clickMarks: ClickMark[] | undefined;
    let clickScreenshot: string | undefined;
    const dumpStart = agent.dump?.executions?.length ?? 0;
    const persistClicks = async () => {
      const collected = collectClickMarks(agent, dumpStart);
      if (!collected.length) return;
      for (let tapIndex = 0; tapIndex < collected.length; tapIndex += 1) {
        const mark = collected[tapIndex]!;
        if (!mark.imageBase64) continue;
        const marked = await drawClickMarks(mark.imageBase64, [mark]);
        mark.screenshot = await saveShot(
          run.id,
          `${caseId}-${index + 1}-click-${tapIndex + 1}.png`,
          marked,
        );
      }
      clickMarks = collected.map(({ imageBase64: _image, ...mark }) => mark);
      clickScreenshot = clickMarks.find((mark) => mark.screenshot)?.screenshot;
    };
    try {
      if (step.type === "action") {
        const openCcb = Boolean(
          launchPackageName && isOpenCcbLongjiLifeAction(step.instruction),
        );
        if (
          openCcb &&
          (coldStartedThisCase || batch.appColdStartedInBatch) &&
          !actionContinuesAfterLaunch(step.instruction)
        ) {
          conclusion = coldStartedThisCase
            ? `案例开始时已冷启动 ${launchPackageName}，跳过重复打开`
            : "批量执行中沿用上一案例的应用状态，跳过打开";
        } else if (openCcb && launchPackageName && !batch.appColdStartedInBatch) {
          await coldStartPackage(run.deviceId, launchPackageName);
          coldStartedThisCase = true;
          batch.appColdStartedInBatch = true;
          conclusion = `已通过 adb 冷启动 ${launchPackageName}`;
        } else {
          const instruction =
            openCcb && (coldStartedThisCase || batch.appColdStartedInBatch)
              ? `应用已在前台，不要从桌面重新打开或再次启动。只完成下面这句话里打开应用之外的操作：${step.instruction}`
              : step.instruction;
          const output = await agent.aiAct(instruction, { effort: "deepThink" });
          if (output) conclusion = output;
          await persistClicks();
          if (clickMarks?.length) {
            conclusion = `${conclusion}。点击落点：${clickConclusion(clickMarks)}`;
          }
          await sleep(AFTER_ACTION_SETTLE_MS);
        }
      } else {
        await agent.aiAssert(step.instruction);
      }
    } catch (error) {
      if (isRunCancelled(run.id)) {
        cancelled = true;
        try {
          await persistClicks();
        } catch {
          clickMarks = undefined;
        }
        const where = clickMarks?.length
          ? `执行已终止。终止前已发生点击：${clickConclusion(clickMarks)}`
          : "执行已终止，这一步没有记录到点击";
        steps.push({
          index,
          type: step.type,
          instruction: step.instruction,
          status: "failed",
          conclusion: where,
          durationMs: Date.now() - started,
          clickScreenshot,
          clickMarks,
        });
        pushSkipped(index + 1, "执行已终止，已跳过");
        break;
      }
      status = "failed";
      failed = true;
      conclusion = error instanceof Error ? error.message : String(error);
      try {
        await persistClicks();
      } catch {
        clickMarks = undefined;
      }
      if (clickMarks?.length) {
        conclusion = `${conclusion}。已发生的点击落点：${clickConclusion(clickMarks)}`;
      }
    }

    if (cancelled) break;

    let screenshot: string | undefined;
    try {
      const base64 = await device.screenshotBase64();
      screenshot = await saveShot(
        run.id,
        `${caseId}-${index + 1}.png`,
        base64,
      );
    } catch (error) {
      conclusion += `（截图失败：${error instanceof Error ? error.message : String(error)}）`;
    }

    const result: StepResult = {
      index,
      type: step.type,
      instruction: step.instruction,
      status,
      conclusion,
      durationMs: Date.now() - started,
      screenshot,
      clickScreenshot,
      clickMarks,
    };
    steps.push(result);
    emit(run.id, { type: "step-done", caseId, step: result });
  }

  const firstFailure = steps.find((step) => step.status === "failed");
  const caseResult: CaseResult = {
    caseId,
    name: testCase.name,
    raw: testCase.raw,
    status: cancelled ? "failed" : failed ? "failed" : "passed",
    conclusion: cancelled
      ? "用户已终止执行"
      : failed
        ? `失败在第 ${firstFailure!.index + 1} 步：${firstFailure!.conclusion}`
        : "全部步骤通过",
    steps,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
  emit(run.id, { type: "case-done", case: caseResult });
  return caseResult;
}

function summarize(run: RunRecord) {
  const passed = run.cases.filter((item) => item.status === "passed").length;
  const failed = run.cases.filter((item) => item.status === "failed").length;
  const skipped = run.cases.filter((item) => item.status === "skipped").length;
  const failures = run.cases
    .filter((item) => item.status === "failed")
    .map((item) => `${item.name}：${item.conclusion}`)
    .join("；");
  const counts = `通过 ${passed} 条，失败 ${failed} 条${skipped ? `，跳过 ${skipped} 条` : ""}。`;
  return failures ? `${counts}${failures}` : counts;
}

export async function startRun(deviceId: string, caseIds: string[]) {
  if (activeRunId) {
    throw new Error("已有任务在执行，请等当前任务结束");
  }
  if (!deviceId) throw new Error("请选择手机");
  if (!caseIds.length) throw new Error("请至少选择一个案例");
  if (
    !process.env.MIDSCENE_MODEL_API_KEY?.trim() ||
    !process.env.MIDSCENE_MODEL_NAME?.trim() ||
    !process.env.MIDSCENE_MODEL_FAMILY?.trim()
  ) {
    throw new Error(
      "请先在系统配置填写 MIDSCENE_MODEL_*（含模型家族 deepseek 等）",
    );
  }

  await refreshMidsceneModelEnv();
  cancelRequested = false;

  const id = new Date().toISOString().replace(/[:.]/g, "-");
  const run: RunRecord = {
    id,
    deviceId,
    status: "running",
    caseIds,
    cases: [],
    summary: "",
    startedAt: new Date().toISOString(),
  };
  runs.set(id, run);
  activeRunId = id;
  void execute(run);
  return run;
}

async function execute(run: RunRecord) {
  const brand = await deviceBrandForRun(run.deviceId);
  const device = new AndroidDevice(
    run.deviceId,
    androidDeviceOptionsForRun(brand),
  );
  const { globalPrompt } = await getAppSettings();
  const prompt = globalPrompt.trim();
  run.globalPrompt = prompt;
  const agent = new AndroidAgent(device, {
    ...(prompt ? { aiContexts: { default: prompt } } : {}),
    waitAfterAction: 800,
  });
  activeAgent = agent;
  try {
    await device.connect();
    const batch: RunBatchState = { appColdStartedInBatch: false };
    let blockedSourceId: string | undefined;
    for (let caseIndex = 0; caseIndex < run.caseIds.length; caseIndex += 1) {
      const caseId = run.caseIds[caseIndex]!;
      if (isRunCancelled(run.id)) {
        throw new RunCancelledError();
      }
      const pending = await getCase(caseId);
      if (
        blockedSourceId &&
        pending?.sourceCaseId === blockedSourceId
      ) {
        const now = new Date().toISOString();
        const skipped: CaseResult = {
          caseId,
          name: pending.name,
          raw: pending.raw,
          status: "skipped",
          conclusion: "同一拆分链路中前面的子案例已失败，停止批量接续",
          steps: pending.steps.map((step, index) => ({
            index,
            type: step.type,
            instruction: step.instruction,
            status: "skipped",
            conclusion: "同一拆分链路中前面的子案例已失败，停止批量接续",
            durationMs: 0,
          })),
          startedAt: now,
          finishedAt: now,
        };
        emit(run.id, { type: "case", caseId });
        emit(run.id, { type: "case-done", case: skipped });
        run.cases.push(skipped);
        continue;
      }
      emit(run.id, { type: "case", caseId });
      const caseResult = await runCase(run, agent, device, caseId, batch, caseIndex);
      run.cases.push(caseResult);
      if (caseResult.status === "failed" && pending?.sourceCaseId) {
        blockedSourceId = pending.sourceCaseId;
      }
      if (isRunCancelled(run.id)) {
        break;
      }
    }
    run.status = run.cases.some((item) => item.status === "failed")
      ? "failed"
      : "passed";
    run.summary = summarize(run);
    run.finishedAt = new Date().toISOString();
    const reportFile = agent.reportFile;
    if (typeof reportFile === "string") run.midsceneReport = reportFile;
  } catch (error) {
    if (error instanceof RunCancelledError || isRunCancelled(run.id)) {
      run.status = "cancelled";
      run.cancelled = true;
      run.error = "用户已终止执行";
      run.summary = "用户已终止执行";
    } else {
      run.status = "failed";
      run.error = error instanceof Error ? error.message : String(error);
      run.summary = run.error;
    }
    run.finishedAt = new Date().toISOString();
  } finally {
    try {
      await agent.destroy();
    } catch {
      /* 报告落盘失败不影响本地结果 */
    }
    activeAgent = null;
    if (!run.midsceneReport && typeof agent.reportFile === "string") {
      run.midsceneReport = agent.reportFile;
    }
    run.tokenUsage = estimateRunTokenUsage(run, run.globalPrompt ?? "");
    await writeReport(run);
    activeRunId = null;
    cancelRequested = false;
    emit(run.id, { type: "done", run });
  }
}
