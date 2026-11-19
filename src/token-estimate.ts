import type { RunRecord, TokenUsageEstimate } from "./types.js";

/** 粗算文本 token（中英混排，仅供报告参考，非厂商账单）。 */
export function estimateTextTokens(text: string): number {
  if (!text.trim()) return 0;
  let score = 0;
  for (const ch of text) {
    score += ch.charCodeAt(0) > 127 ? 0.65 : 0.25;
  }
  return Math.max(1, Math.ceil(score));
}

/** 单步 Midscene 视觉推理的粗算（含多次截图调用，按经验常数）。 */
const VISION_TOKENS_PER_STEP = 4500;
const SYSTEM_OVERHEAD_PER_STEP = 800;

export function estimateRunTokenUsage(
  run: RunRecord,
  globalPrompt: string,
): TokenUsageEstimate {
  const promptBase = estimateTextTokens(globalPrompt);
  let midsceneText = 0;
  let midsceneVision = 0;
  let stepsRun = 0;

  for (const caseResult of run.cases) {
    for (const step of caseResult.steps) {
      if (step.status === "skipped") continue;
      stepsRun += 1;
      midsceneText +=
        promptBase +
        estimateTextTokens(step.instruction) +
        SYSTEM_OVERHEAD_PER_STEP;
      midsceneVision += VISION_TOKENS_PER_STEP;
    }
  }

  const total = midsceneText + midsceneVision;
  const detail =
    stepsRun === 0
      ? "本次无已执行步骤，未产生可估算的 Midscene 调用。"
      : `按 ${stepsRun} 个已执行步骤估算：文本约 ${midsceneText.toLocaleString()}，视觉约 ${midsceneVision.toLocaleString()}（含截图多轮推理）。`;

  return {
    midsceneText,
    midsceneVision,
    total,
    stepsRun,
    detail,
  };
}
