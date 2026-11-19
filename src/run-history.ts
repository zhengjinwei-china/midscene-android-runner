import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RunRecord } from "./types.js";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const runsRoot = path.join(projectRoot, "data/runs");

export type CaseRunHistoryItem = {
  runId: string;
  startedAt: string;
  finishedAt?: string;
  runStatus: RunRecord["status"];
  deviceId: string;
  caseStatus: "passed" | "failed" | "skipped" | "unknown";
  conclusion: string;
  hasReport: boolean;
};

export async function listCaseRunHistory(caseId: string): Promise<CaseRunHistoryItem[]> {
  let dirNames: string[] = [];
  try {
    dirNames = await readdir(runsRoot);
  } catch {
    return [];
  }

  const items: CaseRunHistoryItem[] = [];
  for (const dirName of dirNames) {
    const runDir = path.join(runsRoot, dirName);
    const resultPath = path.join(runDir, "result.json");
    let run: RunRecord;
    try {
      run = JSON.parse(await readFile(resultPath, "utf8")) as RunRecord;
    } catch {
      continue;
    }

    const inRun =
      run.caseIds?.includes(caseId) ||
      run.cases?.some((item) => item.caseId === caseId);
    if (!inRun) continue;

    const caseResult = run.cases?.find((item) => item.caseId === caseId);
    let hasReport = false;
    try {
      await access(path.join(runDir, "report.html"));
      hasReport = true;
    } catch {
      hasReport = false;
    }

    items.push({
      runId: run.id,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      runStatus: run.status,
      deviceId: run.deviceId,
      caseStatus: caseResult?.status ?? "unknown",
      conclusion: caseResult?.conclusion || run.summary || "",
      hasReport,
    });
  }

  return items.sort((a, b) => {
    const at = a.finishedAt || a.startedAt;
    const bt = b.finishedAt || b.startedAt;
    return bt.localeCompare(at);
  });
}

export type HistoricalExecutionStats = {
  /** 历次运行中实际执行过的案例条数（批量运行按条累计）。 */
  historicalCaseExecutions: number;
  /** 上述案例里已跑过的步骤条数（含通过、失败、跳过）。 */
  historicalStepExecutions: number;
};

export async function getHistoricalExecutionStats(): Promise<HistoricalExecutionStats> {
  let dirNames: string[] = [];
  try {
    dirNames = await readdir(runsRoot);
  } catch {
    return { historicalCaseExecutions: 0, historicalStepExecutions: 0 };
  }

  let historicalCaseExecutions = 0;
  let historicalStepExecutions = 0;
  for (const dirName of dirNames) {
    const resultPath = path.join(runsRoot, dirName, "result.json");
    try {
      const run = JSON.parse(await readFile(resultPath, "utf8")) as RunRecord;
      const caseResults = run.cases ?? [];
      historicalCaseExecutions += caseResults.length;
      for (const caseResult of caseResults) {
        historicalStepExecutions += caseResult.steps?.length ?? 0;
      }
    } catch {
      continue;
    }
  }
  return { historicalCaseExecutions, historicalStepExecutions };
}
