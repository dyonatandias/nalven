import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parsePosReadinessMatrix, summarizePosReadiness } from "../lib/erp/pos-readiness";

const source = readFileSync(resolve(process.cwd(), "docs/erp/pdv/PLANO-E-RASTREABILIDADE.md"), "utf8");
const report = summarizePosReadiness(parsePosReadinessMatrix(source));
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (process.argv.includes("--require-production-ready") && !report.productionReady) process.exitCode = 2;
