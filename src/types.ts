export type StepType = "action" | "assert";

export interface Step {
  type: StepType;
  instruction: string;
  /** 批量执行且本案例不是该批第一条时跳过此步（单独执行仍执行）。 */
  skipOnBatchContinue?: boolean;
}

export interface TestCase {
  id: string;
  name: string;
  /** 用户输入的自然语言原文 */
  raw: string;
  packageName?: string;
  /** @deprecated 请改用步骤上的 skipOnBatchContinue；旧案例仍可读 */
  batchSkipSteps?: number;
  /** 大模型拆解后的步骤；未配置模型时为空 */
  steps: Step[];
  planError?: string;
  /** 由哪条长案例拆出 */
  sourceCaseId?: string;
  /** 同一父案例下的执行顺序，从 1 开始 */
  splitOrder?: number;
  updatedAt: string;
}

/** 一次点击在操作前截图上的落点（截图像素，原点在左上）。 */
export interface ClickMark {
  x: number;
  y: number;
  shotWidth?: number;
  shotHeight?: number;
  description?: string;
  /** 这一下落点对应的点击前截图（红圈已画在图上）。 */
  screenshot?: string;
}

export interface StepResult {
  index: number;
  type: StepType;
  instruction: string;
  status: "passed" | "failed" | "skipped";
  conclusion: string;
  durationMs: number;
  screenshot?: string;
  /** 操作前截图，用于标出点击落点。 */
  clickScreenshot?: string;
  clickMarks?: ClickMark[];
}

export interface CaseResult {
  caseId: string;
  name: string;
  raw: string;
  status: "passed" | "failed" | "skipped";
  conclusion: string;
  steps: StepResult[];
  startedAt: string;
  finishedAt: string;
}

export interface TokenUsageEstimate {
  midsceneText: number;
  midsceneVision: number;
  total: number;
  stepsRun: number;
  detail: string;
}

export interface RunRecord {
  id: string;
  deviceId: string;
  status: "queued" | "running" | "passed" | "failed" | "cancelled";
  caseIds: string[];
  cases: CaseResult[];
  summary: string;
  startedAt: string;
  finishedAt?: string;
  midsceneReport?: string;
  error?: string;
  cancelled?: boolean;
  globalPrompt?: string;
  tokenUsage?: TokenUsageEstimate;
  /** 报告页「询问这次执行」里与大模型的多轮对话 */
  askChat?: Array<{ role: "user" | "assistant"; content: string }>;
}

export interface DeviceInfo {
  udid: string;
  state: string;
  model?: string;
  brand?: string;
}
