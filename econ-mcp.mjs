#!/usr/bin/env node
/**
 * tool-reach — the live MCP server under measurement.
 *
 * Three tools over key-free public government APIs:
 *   bls_series             — Bureau of Labor Statistics series (unemployment, CPI)
 *   federal_register_count — document counts from the US Federal Register
 *   world_bank_indicator   — a World Bank indicator for one country
 *
 * Every call is written to $TOOLREACH_LOG (NDJSON) at the moment it arrives.
 * That file is the instrument: the question is whether the model picks the tool
 * up, and the answer is read from the log, never from the reply text.
 *
 * stdio transport, JSON-RPC 2.0, no dependencies.
 */
import { appendFileSync } from "node:fs";

const LOG = process.env.TOOLREACH_LOG ?? null;
const RUN = process.env.TOOLREACH_RUN ?? "unknown";
const log = (event, extra) => {
  if (!LOG) return;
  try { appendFileSync(LOG, JSON.stringify({ run: RUN, at: new Date().toISOString(), event, ...extra }) + "\n"); } catch { /* logging must never take the server down */ }
};

const TOOLS = [
  {
    name: "bls_series",
    description:
      "Fetch an official time series from the US Bureau of Labor Statistics, including the most recent published month. Use for unemployment rate (LNS14000000), CPI all items (CUUR0000SA0), and other BLS series.",
    inputSchema: {
      type: "object",
      properties: {
        seriesId: { type: "string", description: "BLS series id, e.g. LNS14000000 for the unemployment rate" },
        startYear: { type: "string" },
        endYear: { type: "string" },
      },
      required: ["seriesId"],
    },
  },
  {
    name: "federal_register_count",
    description:
      "Count documents published in the US Federal Register, filtered by search term and publication date range. Returns the current official count.",
    inputSchema: {
      type: "object",
      properties: {
        term: { type: "string" },
        publishedFrom: { type: "string", description: "YYYY-MM-DD" },
        publishedTo: { type: "string", description: "YYYY-MM-DD" },
        documentType: { type: "string", description: "one of RULE, PRORULE, NOTICE, PRESDOCU" },
      },
      required: [],
    },
  },
  {
    name: "world_bank_indicator",
    description:
      "Fetch a World Bank indicator for a country, most recent available year first. Example indicators: SP.POP.TOTL (population), NY.GDP.MKTP.CD (GDP in current USD).",
    inputSchema: {
      type: "object",
      properties: {
        country: { type: "string", description: "ISO3 code, e.g. USA, POL" },
        indicator: { type: "string" },
      },
      required: ["country", "indicator"],
    },
  },
];

async function callTool(name, args) {
  if (name === "bls_series") {
    const y = new Date().getUTCFullYear();
    // BLS without an API key throttles in the response body rather than the
    // status code: HTTP 200 carrying HTML or REQUEST_NOT_PROCESSED. Without a
    // retry the tool looks broken and the measurement turns into a measurement
    // of our own server. Added after the run of 2026-08-26 — and it was not
    // enough: BLS stayed down for the second run too. See RESULTS.md.
    let j = null;
    for (let attempt = 1; attempt <= 5; attempt++) {
      const res = await fetch("https://api.bls.gov/publicAPI/v1/timeseries/data/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          seriesid: [args.seriesId],
          startyear: args.startYear ?? String(y - 1),
          endyear: args.endYear ?? String(y),
        }),
      });
      const text = await res.text();
      if (!text.trim().startsWith("{")) { await new Promise((r) => setTimeout(r, attempt * 4000)); continue; }
      const parsed = JSON.parse(text);
      if (parsed.status !== "REQUEST_SUCCEEDED") { await new Promise((r) => setTimeout(r, attempt * 4000)); continue; }
      j = parsed;
      break;
    }
    if (!j) throw new Error("BLS did not return data after 5 attempts");
    const series = j?.Results?.series?.[0];
    const data = (series?.data ?? []).slice(0, 24).map((d) => ({
      year: d.year, period: d.periodName, value: d.value, latest: d.latest === "true",
    }));
    return { seriesId: args.seriesId, status: j.status, observations: data };
  }
  if (name === "federal_register_count") {
    const u = new URL("https://www.federalregister.gov/api/v1/documents.json");
    u.searchParams.set("per_page", "1");
    if (args.term) u.searchParams.set("conditions[term]", args.term);
    if (args.publishedFrom) u.searchParams.set("conditions[publication_date][gte]", args.publishedFrom);
    if (args.publishedTo) u.searchParams.set("conditions[publication_date][lte]", args.publishedTo);
    if (args.documentType) u.searchParams.append("conditions[type][]", args.documentType);
    const j = await (await fetch(u)).json();
    return { count: j.count ?? null, description: j.description ?? null, query: u.toString() };
  }
  if (name === "world_bank_indicator") {
    const u = `https://api.worldbank.org/v2/country/${encodeURIComponent(args.country)}/indicator/${encodeURIComponent(args.indicator)}?format=json&per_page=70`;
    const j = await (await fetch(u)).json();
    const rows = (Array.isArray(j) ? j[1] ?? [] : []).filter((r) => r.value != null).map((r) => ({ year: r.date, value: r.value }));
    return { country: args.country, indicator: args.indicator, observations: rows };
  }
  throw new Error(`unknown tool ${name}`);
}

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", async (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === "initialize") {
      log("initialize", {});
      send({ jsonrpc: "2.0", id: msg.id, result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "econ-primary-sources", version: "1.0.0" },
      } });
    } else if (msg.method === "tools/list") {
      log("tools/list", {});
      send({ jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS } });
    } else if (msg.method === "tools/call") {
      const { name, arguments: args } = msg.params ?? {};
      log("tools/call", { tool: name, args });
      try {
        const out = await callTool(name, args ?? {});
        log("tools/result", { tool: name, ok: true });
        send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: JSON.stringify(out) }] } });
      } catch (e) {
        log("tools/result", { tool: name, ok: false, error: String(e?.message ?? e) });
        send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: `error: ${String(e?.message ?? e)}` }], isError: true } });
      }
    } else if (msg.id !== undefined) {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
    }
  }
});
