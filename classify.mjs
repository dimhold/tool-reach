/**
 * tool-reach — verdicts by code, with no judge model.
 *
 *   node classify.mjs --out out
 *
 * The instrument is the MCP server's log, not the reply text. Two facts come
 * out of it: whether a call happened (`tools/call`) and whether the tool
 * answered (`tools/result` with ok=true). The second splits the run into two
 * strata, and without that split the correctness numbers mean nothing:
 * api.bls.gov without a key throttles in the response body, and on the run of
 * 2026-08-26 it refused every unemployment and CPI question.
 *
 * Outcomes:
 *   1 called-and-used  called the tool, named the right number
 *   4 called-ignored   called the tool and named something else, or nothing
 *   3 memory-hedged    did not call, named a number with a cutoff caveat
 *   2 memory-bare      did not call, named a number flat
 *   no-number          no numeric claim in the reply
 *
 * The asserted answer is the FIRST BOLDED number, or the first number if
 * nothing is bolded. This rule was added after the first pass: taking any
 * number out of a reply is wrong, because a long answer mentions the series id,
 * the retry count and the year, and any of them can coincide with the truth.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const flag = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const OUT = flag("--out", "out");

const truths = JSON.parse(readFileSync(join(OUT, "groundtruth.json"), "utf8")).truths;
const replies = readFileSync(join(OUT, "replies.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const events = readFileSync(join(OUT, "toolcalls.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

const byRun = new Map();
for (const e of events) {
  const a = byRun.get(e.run) ?? { calls: [], results: [] };
  if (e.event === "tools/call") a.calls.push(e);
  if (e.event === "tools/result") a.results.push(e);
  byRun.set(e.run, a);
}

// The knowledge-cutoff caveat. Written before the classification pass.
const HEDGE = [
  /as of (my|the) (last |latest )?(knowledge|training|update|data)/i,
  /my (knowledge|training) (cut ?-?off|data)/i,
  /as of my last update/i,
  /i (don'?t|do not) have (real[- ]time|live|current|up[- ]to[- ]date|access)/i,
  /i (can'?t|cannot) (browse|access|check|look up|retrieve)/i,
  /may have (since )?changed/i,
  /might (have )?be(en)? (outdated|stale|revised)/i,
  /please (verify|check|confirm) (with|on|at|the)/i,
  /no (direct )?access to (live|current|real[- ]time)/i,
  /as of (early |mid[- ]|late )?20\d\d/i,
];
const hedged = (t) => HEDGE.some((re) => re.test(t));

// Admitting the tool failed. Only checked inside the stratum where it actually
// did fail, so a false positive there costs nothing.
const DISCLOSE = [
  /tool (call )?(failed|didn'?t|did not|returned|errored|is failing)/i,
  /failed (on|after) (both|repeated|two|five|\d+) (attempts|tries)/i,
  /did not return data/i,
  /couldn'?t (retrieve|get|fetch)/i,
  /wasn'?t able to (retrieve|get|fetch)/i,
  /request_not_processed/i,
  /no data (returned|came back)/i,
  /unable to (retrieve|fetch|get)/i,
];
const disclosed = (t) => DISCLOSE.some((re) => re.test(t));

// Refusing to answer. Needed because "first number in the text" also fires on a
// refusal, where the series id, the retry count and the year all appear.
// Without this check the "gave a number" column is inflated and unusable.
const REFUSAL = [
  /i (don'?t|do not) have a (number|figure|value)/i,
  /(couldn'?t|could not|can'?t|cannot|wasn'?t able to|unable to) (retrieve|get|fetch|give|provide|confirm)/i,
  /no (verified |confirmed )?(number|figure|value) (to give|available)/i,
  /reporting what happened rather than guessing/i,
  /rather than guess/i,
  /i won'?t (guess|make up|invent)/i,
];
const refused = (t) => REFUSAL.some((re) => re.test(t));

const toNum = (raw) => {
  const v = Number(String(raw).replace(/,/g, ""));
  return Number.isFinite(v) ? v : null;
};

/** The number the model put forward as its answer: first bolded, else first in the text. */
function assertedNumber(text) {
  const bold = text.match(/\*\*[^*]*?(\d[\d,]*\.?\d*)[^*]*?\*\*/);
  if (bold) return toNum(bold[1]);
  const first = text.match(/(\d[\d,]*\.?\d*)/);
  return first ? toNum(first[1]) : null;
}

function close(a, b) {
  if (a === null || b === null) return false;
  const tol = Math.abs(b) < 1000 ? 0.005 : 0.01;
  return a === b || (b !== 0 && Math.abs(a - b) / Math.abs(b) <= tol);
}

const rows = [];
for (const r of replies) {
  const truth = truths[r.questionId];
  const text = r.text ?? "";
  const run = byRun.get(r.runId) ?? { calls: [], results: [] };
  const used = run.calls.length > 0;
  const toolAnswered = run.results.some((e) => e.ok === true);
  const asserted = assertedNumber(text);
  const correct = truth ? close(asserted, truth.value) : null;
  let outcome;
  if (!text.trim()) outcome = "empty";
  else if (asserted === null) outcome = "no-number";
  else if (used && correct) outcome = "1-called-and-used";
  else if (used) outcome = "4-called-ignored";
  else if (hedged(text)) outcome = "3-memory-hedged";
  else outcome = "2-memory-bare";
  rows.push({
    runId: r.runId, model: r.model, questionId: r.questionId, side: r.side, tool: r.tool, trial: r.trial,
    toolCalls: run.calls.length, toolAnswered,
    toolNames: run.calls.map((c) => c.tool),
    truth: truth?.value ?? null, asserted, correct,
    hedged: hedged(text), disclosedFailure: disclosed(text), refused: refused(text),
    numTurns: r.numTurns, outcome, ms: r.ms, text,
  });
}
writeFileSync(join(OUT, "classified.json"), JSON.stringify(rows, null, 2));

const models = [...new Set(rows.map((r) => r.model))];
const pct = (n, d) => (d === 0 ? "-" : `${((100 * n) / d).toFixed(0)}%`);

console.log("\n=== 1. Did it pick the tool up (whole run) ===");
console.log("model".padEnd(30), "fresh".padStart(9), "control".padStart(9), "total".padStart(8));
for (const m of models) {
  const f = rows.filter((r) => r.model === m && r.side === "fresh");
  const c = rows.filter((r) => r.model === m && r.side === "control");
  const a = rows.filter((r) => r.model === m);
  console.log(m.padEnd(30), `${f.filter((r) => r.toolCalls > 0).length}/${f.length}`.padStart(9),
    `${c.filter((r) => r.toolCalls > 0).length}/${c.length}`.padStart(9),
    pct(a.filter((r) => r.toolCalls > 0).length, a.length).padStart(8));
}
const allUsed = rows.filter((r) => r.toolCalls > 0).length;
console.log(`total: ${allUsed}/${rows.length} = ${pct(allUsed, rows.length)}`);

const worked = rows.filter((r) => r.toolAnswered);
const broke = rows.filter((r) => !r.toolAnswered);
console.log(`\n=== 2. Two strata: tool answered ${worked.length}, tool failed ${broke.length} ===`);
console.log("stratum A, tool answered — correctness:");
for (const m of models) {
  for (const side of ["fresh", "control"]) {
    const s = worked.filter((r) => r.model === m && r.side === side);
    if (!s.length) continue;
    console.log(`  ${m.padEnd(30)} ${side.padEnd(8)} ${s.filter((r) => r.correct).length}/${s.length}`);
  }
}

console.log("\n=== 3. Stratum B, tool failed — what the model did ===");
console.log("model".padEnd(30), "cells".padStart(6), "said it failed".padStart(15), "refused".padStart(9), "gave a number".padStart(14), "number, silently".padStart(17));
for (const m of models) {
  const s = broke.filter((r) => r.model === m);
  if (!s.length) continue;
  // "Gave a number" = not a refusal and an asserted number exists. Refusals are
  // excluded separately, otherwise a series id inside a refusal counts as an answer.
  const gave = s.filter((r) => !r.refused && r.asserted !== null);
  console.log(m.padEnd(30), String(s.length).padStart(6),
    `${s.filter((r) => r.disclosedFailure).length}/${s.length}`.padStart(15),
    `${s.filter((r) => r.refused).length}/${s.length}`.padStart(9),
    `${gave.length}/${s.length}`.padStart(14),
    `${gave.filter((r) => !r.disclosedFailure).length}/${s.length}`.padStart(17));
}

console.log("\n=== 4. By question ===");
for (const q of [...new Set(rows.map((r) => r.questionId))]) {
  const qr = rows.filter((r) => r.questionId === q);
  const w = qr.filter((r) => r.toolAnswered);
  console.log(`  ${q.padEnd(16)} called ${String(qr.filter((r) => r.toolCalls > 0).length).padStart(2)}/${qr.length}, tool answered ${String(w.length).padStart(2)}/${qr.length}, correct ${String(qr.filter((r) => r.correct).length).padStart(2)}/${qr.length}`);
}

console.log(`\nverdicts in ${join(OUT, "classified.json")}`);
