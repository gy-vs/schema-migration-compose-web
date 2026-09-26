# Schema Evolution Studio

Workbench for managing migration functions between schema revisions and
comparing all available paths between any two revision pairs on a fixed sample.

## Run

```bash
npm install
npm run dev      # API on :4174, UI on :4173
npm test         # 24 tests: graph/validation, runtime, API scenarios, reducer guard
npm run build    # type-check + production bundle
```

## Model

- **Directed graph** of revisions (`nodes`) connected by weighted `edges`;
  each edge binds a function, carries a `cost`, a `reversible` marker, and an
  optional applicability **condition** (edge-level override or inherited from
  the bound function revision).
- **Functions are versioned.** Publishing appends a revision; edges keep
  working, and every run freezes a snapshot of the revision it started with —
  a long-running experiment never picks up a newly published body.
- **Cycles are detected but allowed.** Back/rollback edges are reported in
  graph diagnostics (`GET /api/graph`) and remain usable; candidate *paths*
  are simple (no repeated node), ranked by **total cost**, never hop count.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/graph` | revisions, functions, edges, cycle diagnostics (`ETag` = revision) |
| POST | `/api/paths` | enumerate, validate, and cost-rank paths for `{start, goal, sample}` |
| POST | `/api/compare` | run every applicable path on one fixed sample under one experiment id |
| POST | `/api/runs` | execute one explicit path (pinned function revisions) |
| GET | `/api/runs/:id` | status with per-edge intermediate outputs and the precise failed edge |
| POST | `/api/runs/:id/cancel` | cooperative cancel (between steps and during `ctx.sleep`) |
| PUT | `/api/funcs/:id/revisions` | publish a new function revision |
| POST/PUT/DELETE | `/api/edges…`, `/api/funcs`, `/api/nodes/:id` | graph edits with optimistic `baseRevision` (409 on conflict) |

Execution verifies each edge's input schema before invoking its function and
the output schema against the destination revision afterwards; a failing edge
stops the run while every earlier intermediate result is retained.

Migration source runs in a Node `vm` sandbox with `ctx.fail()`, `ctx.sleep()`
(capped, cancellation-aware) and `ctx.throwIfAborted()`; preview projection
for candidate validation resolves sleeps immediately.

The UI keeps candidate paths, costs, schema/condition verdicts, and the run
trace stable under polling. A completion carrying an older experiment id (for
example a run bound to a superseded function revision) is discarded and can
never write into the new experiment.
