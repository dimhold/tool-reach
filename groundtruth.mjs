/**
 * tool-reach — ground truth, pulled from the primary source rather than the connector.
 *
 *   node groundtruth.mjs --out out
 *
 * A method caveat named in advance: the connector in this measurement is a thin
 * wrapper over the same APIs, so "independent" here means independent code and
 * an independent request, not an independent source. There should be no
 * discrepancies; if any turn up they go into the method caveats, not the
 * headline.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const flag = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const OUT = flag("--out", "research/tool-reach/out");
mkdirSync(OUT, { recursive: true });

const spec = JSON.parse(readFileSync("questions.json", "utf8"));
const today = new Date().toISOString().slice(0, 10);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * BLS without a key intermittently returns an HTML page instead of JSON: the
 * throttling lives in the body, not the status code. Read it as "try later"
 * rather than as a refusal.
 */
async function bls(seriesId, startYear, endYear) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const r = await fetch("https://api.bls.gov/publicAPI/v1/timeseries/data/", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ seriesid: [seriesId], startyear: startYear, endyear: endYear }),
    });
    const text = await r.text();
    if (!text.trim().startsWith("{")) { await sleep(attempt * 3000); continue; }
    const j = JSON.parse(text);
    if (j.status !== "REQUEST_SUCCEEDED") { await sleep(attempt * 3000); continue; }
    await sleep(1500);
    return j.Results.series[0].data;
  }
  throw new Error(`BLS: five consecutive attempts returned no JSON for ${seriesId}`);
}

async function frCount(documentType, from, to) {
  const u = new URL("https://www.federalregister.gov/api/v1/documents.json");
  u.searchParams.set("per_page", "1");
  u.searchParams.append("conditions[type][]", documentType);
  u.searchParams.set("conditions[publication_date][gte]", from);
  u.searchParams.set("conditions[publication_date][lte]", to);
  const j = await (await fetch(u)).json();
  return { count: j.count, url: u.toString() };
}

async function wb(country, indicator) {
  const u = `https://api.worldbank.org/v2/country/${country}/indicator/${indicator}?format=json&per_page=80`;
  const j = await (await fetch(u)).json();
  return (j[1] ?? []).filter((r) => r.value != null).map((r) => ({ year: r.date, value: r.value }));
}

async function resolve(t) {
  if (t.kind === "bls-latest") {
    const y = new Date().getUTCFullYear();
    const data = await bls(t.seriesId, String(y - 1), String(y));
    const latest = data.find((d) => d.latest === "true") ?? data[0];
    return { value: Number(latest.value), label: `${latest.periodName} ${latest.year}`, raw: latest };
  }
  if (t.kind === "bls-point") {
    const data = await bls(t.seriesId, t.year, t.year);
    const p = data.find((d) => d.period === t.period);
    if (!p) throw new Error(`BLS: no observation for ${t.seriesId} ${t.year} ${t.period}`);
    return { value: Number(p.value), label: `${p.periodName} ${p.year}`, raw: p };
  }
  if (t.kind === "fr-count") {
    const to = t.to === "TODAY" ? today : t.to;
    const r = await frCount(t.documentType, t.from, to);
    return { value: r.count, label: `${t.documentType} ${t.from}..${to}`, raw: r };
  }
  if (t.kind === "wb-latest") {
    const rows = await wb(t.country, t.indicator);
    return { value: rows[0].value, label: `${t.country} ${rows[0].year}`, raw: rows[0] };
  }
  if (t.kind === "wb-point") {
    const rows = await wb(t.country, t.indicator);
    const p = rows.find((r) => r.year === t.year);
    if (!p) throw new Error(`WB: no observation for ${t.country} ${t.year}`);
    return { value: p.value, label: `${t.country} ${p.year}`, raw: p };
  }
  throw new Error(`unknown truth kind: ${t.kind}`);
}

const out = { takenAt: new Date().toISOString(), truths: {} };
for (const pair of spec.pairs) {
  for (const side of ["fresh", "control"]) {
    const q = pair[side];
    const truth = await resolve(q.truth);
    out.truths[q.id] = { side, tool: pair.tool, prompt: q.prompt, ...truth };
    console.log(`${q.id.padEnd(16)} ${String(truth.value).padStart(14)}  (${truth.label})`);
  }
}
writeFileSync(join(OUT, "groundtruth.json"), JSON.stringify(out, null, 2));
console.log(`\nwritten to ${join(OUT, "groundtruth.json")}`);
