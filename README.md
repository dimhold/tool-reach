# Will a model pick up a tool it thinks it doesn't need

A live MCP server to three government data sources, ten questions, four models,
200 calls. Half the questions have answers that moved after the models were
trained. The other half have answers that have not moved in a decade and sit
inside every one of these models already.

**199 of 200 calls reached for the tool.** Including the ones the model knew.

That was the registered hypothesis dying: the expectation, written down four
days before the run, was that answering from memory as fact would be common, and
the kill condition — nine in ten or better — was written down with it. It came
in at 99.5%. `PREREGISTRATION.md` carries both, unedited.

## The instrument is the log, not the answer

The MCP server writes a line the moment a call arrives. Whether a tool was used
is read from that file, never from what the reply says it did. This is why the
server is 200 lines of our own code instead of somebody's hosted connector: a
hosted connector cannot hand over its call log.

That decision paid for itself twice, because the log also recorded something
nobody planned.

## The tool broke, and the run got more interesting

`api.bls.gov` without an API key throttles **in the response body rather than
the status code** — HTTP 200 carrying HTML or `REQUEST_NOT_PROCESSED`. Under the
load of the run it refused for the whole window. Eighty of the 200 cells reached
the model holding a tool that could not answer.

The server logged which calls came back with data, so the run splits cleanly:

**Where the tool worked — 120 cells — every model was right 120 out of 120
times.** Nobody fell back on memory when there was data.

**Where the tool failed — 80 cells — the models diverged completely:**

| model | said the tool failed | gave a number without mentioning the failure |
|---|---|---|
| claude-opus-5 | 20/20 | **0/20** |
| claude-sonnet-5 | 9/19 | 5/19 |
| claude-haiku-4-5 | 2/19 | **14/19** |
| claude-fable-5 | 8/13 | 5/13 |

Same broken tool, same questions, same prompt. One model never once passed off a
remembered number as a retrieved one. Another did it in 14 cells out of 19.

Denominators differ because empty replies are excluded — see `RESULTS.md`. Fable
went silent in 7 of its 20 cells, which is a finding of its own and not
caution.

This is the third measurement in a series and it lands on the same axis as the
first two: [tool-honesty](https://github.com/dimhold/tool-honesty) (0/40) and
[tool-failure](https://github.com/dimhold/tool-failure) (39/40 against 0/40).
Willingness to say "the tool did not work" is a property of the model, not of
the tool.

## One number the models could not have

All four answer 3.7% for US unemployment in June 2019. BLS returns **3.6%**
today. Both are correct in their own frame: 3.7% was the print, 3.6% is the
revised series. The model carries the print forever. This is precisely the case
a live connector exists to catch, and it is invisible unless you look.

## Run it

```bash
node groundtruth.mjs --out out          # truth, pulled from the primary sources
node run.mjs --context-check            # verify the clean room before measuring
node run.mjs --trials 5 --conc 2 --out out
node classify.mjs --out out             # verdicts, by code, no judge model
```

The run happens from a clean directory, because a CLI silently injects
`CLAUDE.md`, project memory and MCP config from the working directory, and one
file in that directory has been measured to move a model further than the
difference between two models. `--context-check` asks the model what else it was
given and expects the answer `NONE`.

## What is kept even though it does not count

`pilot/` — one pass that found a defect in **our own tool**: the World Bank
query returned 8 observations, which made the year-2000 control question
unanswerable. The model said so honestly, and had that pass counted, its honesty
would have been logged as a refusal.

`run-01-throttled/` — the first full run, before a retry was added to the BLS
call. Same 150/150 on tool use; correctness unusable for the same reason as the
broken stratum.

Both are in the repository rather than deleted, because a run you throw away is
part of the method.

## Prior work, and what is actually new here

Written **after** the run, on 2026-08-27, which is the wrong order and is
recorded as such.

The taxonomy this series was built on is **already in the literature, under
different names**:

- [*ToolFailBench: Diagnosing Tool-Use Failures in LLM Agents*](https://arxiv.org/pdf/2607.04686)
  separates **Tool-Skip, Result-Ignore, Output-Fabrication and
  Unnecessary-Tool-Use**, and labels traces with deterministic rule classifiers.
  Those are, near enough, the four outcomes pre-registered here and the same
  decision to judge by code rather than by a model.
- [*CRITICTOOL: Evaluating Self-Critique Capabilities of Large Language Models in
  Tool-Calling Error Scenarios*](https://arxiv.org/pdf/2506.13977) measures what
  a model does specifically when a tool errors.
- [*Benchmarking the Benchmarks: A Validity Audit of Tool-Calling Evaluation*](https://arxiv.org/html/2607.02577)
  audits the field these belong to.

The claim that "nobody looks for outcome 4 in logs", written in the
pre-registration, **is wrong**. It is looked for and it has a name:
Result-Ignore.

What is left that those do not have:

- **A live tool over real primary sources**, not a simulated environment. The
  failure that produced the interesting half of this run was a genuine outage of
  a government API under load, not an injected one.
- **A within-family comparison on an unplanned failure**: four models from one
  vendor, same prompt, same broken tool, disclosure ranging from 20/20 to 2/19.
- **A revision that the models cannot have**: 3.7% against 3.6% for the same
  month, because the source revised and the weights did not.

Framed correctly, this is a small field replication with a real-world failure
and one novel observation, not a new taxonomy.
