import {afterEach, describe, expect, it} from 'vitest';
import request from 'supertest';
import {createApp} from '../src/server/index';
import type {Experiment, PathInfo} from '../src/shared/types';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function waitForExperiment(
  app: ReturnType<typeof createApp>,
  id: string,
  timeoutMs = 3000
): Promise<Experiment> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = await request(app).get(`/api/experiments/${id}`).expect(200);
    if (response.body.status !== 'running') return response.body as Experiment;
    if (Date.now() > deadline) throw new Error('experiment did not finish in time');
    await sleep(10);
  }
}

async function startExperiment(
  app: ReturnType<typeof createApp>,
  payload: Record<string, unknown>
): Promise<{id: string; paths: PathInfo[]}> {
  const response = await request(app).post('/api/experiments').send(payload).expect(202);
  return {id: response.body.id, paths: response.body.paths};
}

describe('schema evolution service', () => {
  it('returns multiple equivalent paths ordered by cost, not edge count', async () => {
    const app = createApp();
    const response = await request(app).get('/api/paths?from=v1&to=v4').expect(200);
    const costs = response.body.paths.map((path: PathInfo) => path.totalCost);
    const hops = response.body.paths.map((path: PathInfo) => path.hops);

    // v1-a->v2-b->v3-c->v4 costs 7; v1-a->v2-x->v4 costs 9; direct g is the
    // single-hop path but costs 8 and needs legacyId.
    expect(costs).toEqual([7, 8, 9]);
    expect(hops).toEqual([3, 1, 2]);
    const sorted = [...costs].sort((a, b) => a - b);
    expect(costs).toEqual(sorted);
  });

  it('fails the conditional path when the applicability condition is not met, but compares other paths', async () => {
    const app = createApp();
    const {id} = await startExperiment(app, {from: 'v1', to: 'v4', sampleId: 'modern'});
    const experiment = await waitForExperiment(app, id);

    expect(experiment.status).toBe('completed');
    const failedRun = experiment.runs.find(run => run.edgeIds.includes('g'));
    expect(failedRun?.status).toBe('failed');
    expect(failedRun?.failedEdgeId).toBe('g');
    expect(failedRun?.steps[0].stage).toBe('condition');
    expect(failedRun?.steps[0].error).toMatch(/legacyId/);
    expect(failedRun?.steps).toHaveLength(1); // precise failing edge recorded

    const cheapest = experiment.runs.find(run => run.totalCost === 7);
    expect(cheapest?.status).toBe('succeeded');
    expect(cheapest?.result).toMatchObject({id: 'ac-0042', verified: true, segment: 'trusted'});
  });

  it('uses the condition path successfully on a legacy sample', async () => {
    const app = createApp();
    const {id} = await startExperiment(app, {from: 'v1', to: 'v4', sampleId: 'legacy'});
    const experiment = await waitForExperiment(app, id);
    const direct = experiment.runs.find(run => run.edgeIds.join() === 'g');
    expect(direct?.status).toBe('succeeded');
    expect(direct?.result).toMatchObject({segment: 'legacy', verified: true});
  });

  it('binds the function revision at execution so a function update cannot rewrite a running experiment', async () => {
    const app = createApp({stepDelayMs: 30});
    // Update edge a first: new function revision.
    const graph = await request(app).get('/api/graph').expect(200);
    await request(app)
      .put('/api/edges/a')
      .send({
        revision: graph.body.graph.revision,
        body: 'doc.email = "changed@example.com";\nreturn doc;',
      })
      .expect(200);

    const started = await request(app)
      .post('/api/experiments')
      .send({from: 'v1', to: 'v4', sampleId: 'modern'})
      .expect(202);

    // While the experiment runs, update the function again.
    const midGraph = await request(app).get('/api/graph').expect(200);
    await request(app)
      .put('/api/edges/a')
      .send({revision: midGraph.body.graph.revision, body: 'doc.email = "third@example.com";\nreturn doc;'})
      .expect(200);

    const experiment = await waitForExperiment(app, started.body.id);
    const cheapest = experiment.runs.find((run: Experiment['runs'][number]) => run.totalCost === 7);
    expect(cheapest).toBeDefined();
    expect(cheapest!.status).toBe('succeeded');
    // Bound to the revision seen when the experiment started.
    const firstEdge = cheapest!.steps[0];
    expect(firstEdge.edgeId).toBe('a');
    expect(firstEdge.fnRevision).toBe(2);
    expect(cheapest!.result).toMatchObject({email: 'changed@example.com'});
  });

  it('refuses stale concurrent graph edits with a revision conflict', async () => {
    const app = createApp();
    const first = await request(app).get('/api/graph').expect(200);
    const revision = first.body.graph.revision;

    await request(app).put('/api/edges/b').send({revision, cost: 5}).expect(200);
    const stale = await request(app).put('/api/edges/b').send({revision, cost: 9}).expect(409);
    expect(stale.body.error).toBe('revision_conflict');
    expect(stale.body.currentRevision).toBe(revision + 1);

    // The stale write did not land.
    const response = await request(app).get('/api/paths?from=v1&to=v4').expect(200);
    expect(response.body.paths.find((p: PathInfo) => p.edgeIds.join() === 'a,b,c').totalCost).toBe(10);
  });

  it('plans rollback paths using reversible back edges and detects cycles', async () => {
    const app = createApp();
    const forwardOnly = await request(app).get('/api/paths?from=v3&to=v1').expect(200);
    expect(forwardOnly.body.paths).toHaveLength(0);

    const withRollback = await request(app).get('/api/paths?from=v3&to=v1&rollback=true').expect(200);
    expect(withRollback.body.paths[0].nodeIds).toEqual(['v3', 'v2', 'v1']);
    expect(withRollback.body.paths[0].hasRollback).toBe(true);

    const cycles = await request(app).get('/api/graph').expect(200);
    expect(cycles.body.cycles.length).toBeGreaterThan(0);
  });

  it('flags a non-reversible rollback edge as unusable instead of silently dropping the path', async () => {
    const app = createApp();
    // Break reversibility of the v2->v3 forward edge; v3->v2 rollback is blocked.
    const graph = await request(app).get('/api/graph').expect(200);
    await request(app).put('/api/edges/b').send({revision: graph.body.graph.revision, reversible: false}).expect(200);
    const paths = await request(app).get('/api/paths?from=v3&to=v1&rollback=true').expect(200);
    expect(paths.body.paths.length).toBeGreaterThan(0);
    expect(paths.body.paths.every((path: PathInfo) => path.valid === false)).toBe(true);
    expect(
      paths.body.paths.some((path: PathInfo) =>
        path.issues.some((issue: {code: string}) => issue.code === 'rollback_not_reversible')
      )
    ).toBe(true);
  });

  it('retains intermediate results and the precise failing edge on partial failure', async () => {
    const app = createApp();
    // Make edge b throw at runtime.
    const graph = await request(app).get('/api/graph').expect(200);
    await request(app)
      .put('/api/edges/b')
      .send({revision: graph.body.graph.revision, body: 'throw new Error("b is broken")'})
      .expect(200);

    const {id} = await startExperiment(app, {from: 'v1', to: 'v4', sampleId: 'modern'});
    const experiment = await waitForExperiment(app, id);

    const brokenPath = experiment.runs.find(run => run.edgeIds.join() === 'a,b,c');
    expect(brokenPath?.status).toBe('failed');
    expect(brokenPath?.failedEdgeId).toBe('b');
    expect(brokenPath?.steps).toHaveLength(2);
    expect(brokenPath?.steps[0].status).toBe('ok');
    expect(brokenPath?.steps[0].output).toMatchObject({email: 'user0042@example.com'});
    expect(brokenPath?.steps[1].status).toBe('failed');
    expect(brokenPath?.steps[1].stage).toBe('function');
    expect(brokenPath?.steps[1].error).toMatch(/b is broken/);

    // An equivalent alternative path still completes on the same sample.
    const alternative = experiment.runs.find(run => run.edgeIds.join() === 'a,x');
    expect(alternative?.status).toBe('succeeded');
    expect(alternative?.result).toMatchObject({segment: 'migration'});
  });

  it('cancels a running experiment, marking remaining paths cancelled while finished runs stay intact', async () => {
    const app = createApp({stepDelayMs: 40});
    const started = await request(app)
      .post('/api/experiments')
      .send({from: 'v1', to: 'v4', sampleId: 'modern'})
      .expect(202);

    await sleep(55); // one path should have finished or be mid-flight
    await request(app).post(`/api/experiments/${started.body.id}/cancel`).expect(200);
    const experiment = await waitForExperiment(app, started.body.id);

    expect(experiment.status).toBe('cancelled');
    expect(experiment.runs.length).toBe(3); // all paths accounted for
    const statuses = experiment.runs.map(run => run.status);
    expect(statuses).toContain('cancelled');
    // The first completed run, if any, is never retroactively rewritten.
    for (const run of experiment.runs) {
      if (run.status === 'succeeded') expect(run.result).toBeTruthy();
    }
  });

  it('flags edges whose declared schemas do not line up with endpoint revisions', async () => {
    const app = createApp();
    const graph = await request(app).get('/api/graph').expect(200);
    await request(app)
      .put('/api/edges/c')
      .send({
        revision: graph.body.graph.revision,
        inputSchema: {fields: [{name: 'id', type: 'string'}, {name: 'ssn', type: 'string'}]},
      })
      .expect(200);

    const response = await request(app)
      .post('/api/compose/validate')
      .send({edgeIds: ['a', 'b', 'c']})
      .expect(200);
    expect(response.body.valid).toBe(false);
    expect(response.body.issues.map((issue: {code: string}) => issue.code)).toContain('input_incompatible');
    expect(response.body.issues.map((issue: {code: string}) => issue.code)).toContain('chain_incompatible');
  });

  afterEach(() => {});
});
