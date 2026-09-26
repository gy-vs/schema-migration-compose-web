import type {Experiment, PathRun} from '../shared/types';

/**
 * A polled experiment belongs to the experiment the user currently has open.
 * Completion of an older experiment must never overwrite a newer one: the
 * caller compares a monotonically increasing session token.
 */
export function isStaleExperiment(currentId: string | null, polledId: string): boolean {
  return currentId === null || currentId !== polledId;
}

export interface RunSummary {
  key: string;
  status: PathRun['status'];
  totalCost: number;
  hops: number;
  hasRollback: boolean;
  result?: unknown;
  error?: string;
  failedEdgeId?: string;
}

/** Align the runs of one experiment with the path order returned at start. */
export function summarizeRuns(experiment: Experiment): RunSummary[] {
  return [...experiment.runs]
    .sort((a, b) => a.pathIndex - b.pathIndex)
    .map(run => ({
      key: run.edgeIds.join(',') || '(same node)',
      status: run.status,
      totalCost: run.totalCost,
      hops: run.hops,
      hasRollback: run.hasRollback,
      result: run.result,
      error: run.error,
      steps: run.steps,
      failedEdgeId: run.failedEdgeId,
    }));
}

export function bestSuccessfulRun(experiment: Experiment): PathRun | undefined {
  const successful = experiment.runs.filter(run => run.status === 'succeeded');
  // Cost first on purpose — shortest edge count is not the goal.
  return successful.sort((a, b) => a.totalCost - b.totalCost || a.hops - b.hops)[0];
}

/** Side-by-side result columns for fixed-sample comparison. */
export function buildComparison(experiment: Experiment): {
  keys: string[];
  byKey: Map<string, RunSummary>;
} {
  const summaries = summarizeRuns(experiment);
  return {keys: summaries.map(summary => summary.key), byKey: new Map(summaries.map(summary => [summary.key, summary]))};
}

export function compareJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Equivalent paths = succeed and produce the same final document. */
export function equivalenceGroups(experiment: Experiment): string[][] {
  const summaries = summarizeRuns(experiment).filter(summary => summary.status === 'succeeded');
  const groups: string[][] = [];
  for (const summary of summaries) {
    const serialized = JSON.stringify(summary.result);
    const group = groups.find(candidate => {
      const representative = summaries.find(s => s.key === candidate[0]);
      return representative && JSON.stringify(representative.result) === serialized;
    });
    if (group) group.push(summary.key);
    else groups.push([summary.key]);
  }
  return groups.filter(group => group.length > 1);
}
