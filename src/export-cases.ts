import ExcelJS from "exceljs";
import type { Step, TestCase } from "./types.js";

function numbered(steps: Step[]) {
  if (!steps.length) return "";
  if (steps.length === 1) return steps[0]!.instruction;
  return steps.map((step, index) => `${index + 1}、${step.instruction}`).join("\n");
}

export async function casesToXlsx(
  items: TestCase[],
  parents: ReadonlyMap<string, TestCase> = new Map(),
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("案例");
  sheet.columns = [
    { header: "案例标题", key: "title", width: 36 },
    { header: "案例概述", key: "summary", width: 36 },
    { header: "步骤描述", key: "steps", width: 64 },
    { header: "预期结果", key: "expect", width: 64 },
  ];
  sheet.getRow(1).font = { bold: true };
  for (const item of items) {
    const parent = item.sourceCaseId ? parents.get(item.sourceCaseId) : undefined;
    const title = parent ? `${parent.name}${item.splitOrder ?? ""}` : item.name;
    const summary = parent ? item.name : item.name;
    const row = sheet.addRow({
      title,
      summary,
      steps: numbered(item.steps.filter((step) => step.type === "action")),
      expect: numbered(item.steps.filter((step) => step.type === "assert")),
    });
    row.alignment = { wrapText: true, vertical: "top" };
  }
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
