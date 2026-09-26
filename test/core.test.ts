import {describe, expect, it} from 'vitest';
import {seedGraph} from '../src/server/seed';
import {detectCycles, findPaths, isRollbackEdge, rollbackUsable, validateEdge} from '../src/shared/graph';
import {runMigration} from '../src/shared/functions';
import {bestSuccessfulRun, isStaleExperiment} from '../src/client/guards';
import type {Experiment, PathRun} from '../src/shared/types';

describe('graph core', () => {
  it('orders paths by cost even when a cheaper path has more edges', () => {
    const graph = seedGraph();
    const paths = findPaths(graph, 'v1', 'v4');
    expect(paths.map(path => path.totalCost)).toEqual([7, 8, 9]);
    expect(paths.map(path => path.hops)).toEqual([3, 1, 2]);
    // The cheapest must not be assumed to be the shortest.
    expect(paths[0].hops).toBeGreaterThan(paths[1].hops);
  });

  it('keeps invalid paths but flags them with precise issues', () => {
    const graph = seedGraph();
    const edge = graph.edges.find(e => e.id === 'c')!;
    edge.inputSchema = {fields: [{name: 'id', type: 'string'}, {name: 'ssn', type: 'string'}]};
    const paths = findPaths(graph, 'v1', 'v4');
    const broken = paths.find(path => path.edgeIds.join() === 'a,b,c');
    expect(broken?.valid).toBe(false);
    expect(broken?.issues.some(issue => issue.code === 'input_incompatible')).toBe(true);
    expect(broken?.issues.some(issue => issue.code === 'chain_incompatible')).toBe(true);
  });

  it('detects cycles created by back edges without removing them', () => {
    const graph = seedGraph();
    const cycles = detectCycles(graph);
    const joined = cycles.map(cycle => cycle.nodeIds.join(','));
    expect(joined.some(nodes => nodes === 'v1,v2,v1')).toBe(true);
    expect(graph.edges.some(edge => isRollbackEdge(graph, edge))).toBe(true);
  });

  it('hides rollback edges unless requested and only when reversible', () => {
    const graph = seedGraph();
    expect(findPaths(graph, 'v3', 'v1')).toHaveLength(0);
    const withRollback = findPaths(graph, 'v3', 'v1', {rollback: true});
    expect(withRollback[0].edgeIds).toEqual(['r23', 'r12']);

    const backEdge = graph.edges.find(edge => edge.id === 'r23')!;
    expect(rollbackUsable(graph, backEdge)).toBe(true);
    const forward = graph.edges.find(edge => edge.id === 'b')!;
    forward.reversible = false;
    expect(rollbackUsable(graph, backEdge)).toBe(false);
  });

  it('reports compile and schema problems for bad edges', () => {
    const graph = seedGraph();
    const edge = graph.edges.find(e => e.id === 'a')!;
    edge.fn.body = 'this is not javascript {{{';
    const issues = validateEdge(graph, edge);
    expect(issues.some(issue => issue.code === 'bad_function')).toBe(true);
  });
});

describe('function runner', () => {
  it('does not mutate the input document when the function throws', () => {
    const input = {id: 'x', keep: true};
    const outcome = runMigration('doc.added = 1; throw new Error("boom")', input);
    expect(outcome.ok).toBe(false);
    expect(input).toEqual({id: 'x', keep: true});
  });

  it('validates output against the declared output schema', () => {
    const outcome = runMigration('doc.email = 123; return doc;', {id: 'x'}, {
      fields: [
        {name: 'id', type: 'string'},
        {name: 'email', type: 'string'},
      ],
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/email/);
  });
});

describe('client guards', () => {
  it('treats a late-completing older experiment as stale', () => {
    expect(isStaleExperiment('new-id', 'old-id')).toBe(true);
    expect(isStaleExperiment('same-id', 'same-id')).toBe(false);
    expect(isStaleExperiment(null, 'anything')).toBe(true);
  });

  it('picks the lowest-cost successful run rather than fewest steps', () => {
    const run = (cost: number, hops: number): PathRun => ({
      pathIndex: 0,
      edgeIds: [],
      hops,
      totalCost: cost,
      hasRollback: false,
      status: 'succeeded',
      steps: [],
    });
    const experiment: Experiment = {
      id: 'e',
      graphRevision: 1,
      sampleId: null,
      sample: {},
      status: 'completed',
      createdAt: 0,
      runs: [{...run(9, 1), pathIndex: 0}, {...run(7, 3), pathIndex: 1}, {...run(20, 2), pathIndex: 2}],
    };
    expect(bestSuccessfulRun(experiment)?.totalCost).toBe(7);
  });
});
