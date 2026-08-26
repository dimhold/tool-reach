/**
 * tool-reach — will a model pick up a tool it thinks it does not need.
 *
 *   node run.mjs --trials 5 --out out
 *   node run.mjs --context-check      # verify the clean room, measure nothing
 *
 * The run happens FROM A CLEAN DIRECTORY. The CLI silently injects CLAUDE.md and
 * the working directory's memory, and one file in that directory has been
 * measured to move a model further than the difference between two models.
 *
 * The instrument is the MCP server's log, not the reply text: whether a call
 * happened is read from there. Append-only NDJSON, the file is its own resume
 * state.
 */
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, copyFileSync, rmSync, readdirSync } from "node:fs";
import { join, resolve as abs } from "node:path";

const argv = process.argv.slice(2);
const flag = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const has = (k) => argv.includes(k);
const TRIALS = Number(flag("--trials", "5"));
const OUT = abs(flag("--out", "research/tool-reach/out"));
const CONC = Number(flag("--conc", "3"));
const CLEAN = abs(flag("--clean", "D:/Temp/claude/tool-reach-cleanroom"));
const MODELS = flag("--models", "claude-opus-5,claude-sonnet-5,claude-haiku-4-5-20251001,claude-fable-5").split(",");
// Ceiling on a single call. 180 s was enough for the first three models, whose
// median is 11-13 s. Two probe calls were truncated at it, and a ceiling that
// truncates replies measures the ceiling, so it is a flag now.
const CALL_TIMEOUT_MS = Number(flag("--timeout", "420000"));

mkdirSync(OUT, { recursive: true });
// The clean room is not wiped wholesale: on Windows the directory stays locked
// after a killed child process and rmSync fails with EBUSY. Overwriting the
// server and clearing old configs is enough.
mkdirSync(CLEAN, { recursive: true });
for (const f of readdirSync(CLEAN)) {
  if (f.startsWith("mcp-") && f.endsWith(".json")) { try { rmSync(join(CLEAN, f)); } catch { /* locked, survivable */ } }
}
copyFileSync("econ-mcp.mjs", join(CLEAN, "econ-mcp.mjs"));

const TOOL_LOG = join(OUT, "toolcalls.ndjson");
const REPLIES = join(OUT, "replies.ndjson");

function mcpConfig(runId) {
  const cfg = {
    mcpServers: {
      econ: {
        command: "node",
        args: [join(CLEAN, "econ-mcp.mjs")],
        env: { TOOLREACH_LOG: TOOL_LOG, TOOLREACH_RUN: runId },
      },
    },
  };
  // runId carries | and : — Windows will not take those in a filename
  const p = join(CLEAN, `mcp-${runId.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`);
  writeFileSync(p, JSON.stringify(cfg));
  return p;
}

const ALLOWED = "mcp__econ__bls_series,mcp__econ__federal_register_count,mcp__econ__world_bank_indicator";

function askClaude(prompt, model, runId) {
  const cfgPath = mcpConfig(runId);
  const args = [
    "-p", "--output-format", "json", "--model", model,
    "--strict-mcp-config", "--mcp-config", `"${cfgPath}"`,
    "--allowedTools", `"${ALLOWED}"`,
    "--max-turns", "8",
  ];
  return new Promise((resolveP) => {
    const t0 = Date.now();
    const child = spawn("claude", args, { shell: true, windowsHide: true, cwd: CLEAN });
    let out = "", err = "";
    const killer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } }, CALL_TIMEOUT_MS);
    child.stdout.on("data", (d) => (out += d.toString("utf8")));
    child.stderr.on("data", (d) => (err += d.toString("utf8")));
    child.on("error", (e) => { clearTimeout(killer); resolveP({ error: String(e?.message ?? e), ms: Date.now() - t0 }); });
    child.on("close", (code) => {
      clearTimeout(killer);
      let envelope = null;
      try { envelope = JSON.parse(out); } catch { /* not JSON */ }
      resolveP({
        code, ms: Date.now() - t0,
        text: typeof envelope?.result === "string" ? envelope.result : null,
        apiErrorStatus: envelope?.api_error_status ?? null,
        modelUsage: envelope?.modelUsage ?? null,
        numTurns: envelope?.num_turns ?? null,
        stderr: err.slice(0, 500),
        rawHead: envelope ? null : out.slice(0, 500),
      });
    });
    child.stdin.write(prompt, "utf8");
    child.stdin.end();
  });
}

if (has("--context-check")) {
  // The clean-room check: what reached the context besides the prompt.
  const probe = "List every file whose contents were provided to you before my message in this conversation, with full paths. If there were none, reply exactly: NONE.";
  for (const model of MODELS) {
    const r = await askClaude(probe, model, `ctx-${model}`);
    console.log(`\n--- ${model} ---\n${r.text ?? r.rawHead ?? r.error}`);
    appendFileSync(join(OUT, "context-check.ndjson"), JSON.stringify({ model, at: new Date().toISOString(), reply: r.text, code: r.code }) + "\n");
  }
  process.exit(0);
}

const spec = JSON.parse(readFileSync("questions.json", "utf8"));
const questions = [];
for (const pair of spec.pairs) for (const side of ["fresh", "control"]) questions.push({ ...pair[side], side, tool: pair.tool, pairId: pair.id });

const done = new Set();
if (existsSync(REPLIES)) {
  for (const line of readFileSync(REPLIES, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { done.add(JSON.parse(line).runId); } catch { /* truncated tail line */ }
  }
}

const jobs = [];
for (const model of MODELS) {
  for (const q of questions) {
    for (let t = 1; t <= TRIALS; t++) {
      const runId = `${model}|${q.id}|${t}`;
      if (!done.has(runId)) jobs.push({ runId, model, q, trial: t });
    }
  }
}
console.log(`cells: ${MODELS.length} models x ${questions.length} questions x ${TRIALS} trials = ${MODELS.length * questions.length * TRIALS}; remaining ${jobs.length}`);

let i = 0, finished = 0;
async function worker(w) {
  while (true) {
    const idx = i++;
    if (idx >= jobs.length) return;
    const job = jobs[idx];
    const r = await askClaude(job.q.prompt, job.model, job.runId);
    appendFileSync(REPLIES, JSON.stringify({
      runId: job.runId, model: job.model, questionId: job.q.id, side: job.q.side,
      pairId: job.q.pairId, tool: job.q.tool, trial: job.trial,
      at: new Date().toISOString(), ...r,
    }) + "\n");
    finished++;
    if (finished % 10 === 0 || r.error || r.code !== 0) {
      console.log(`  ${finished}/${jobs.length} ${job.runId} -> ${r.code === 0 ? "ok" : `exit ${r.code} ${r.apiErrorStatus ?? ""} ${(r.rawHead ?? r.error ?? "").slice(0, 120)}`}`);
    }
  }
}
await Promise.all(Array.from({ length: CONC }, (_, w) => worker(w)));
console.log(`done: replies in ${REPLIES}, tool calls in ${TOOL_LOG}`);
