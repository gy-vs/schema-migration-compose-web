import {evalCondition} from '../shared/conditions';
import {runMigration} from '../shared/functions';
import type {Experiment, MigrationEdge, PathInfo, PathRun, StepResult} from '../shared/types';

export class CancelledError extends Error {
  constructor() {
    super('execution cancelled');
    this.name = 'CancelledError';
  }
}

export class CancellationToken {
  private cancelled = false;
  private listeners = new Set<() => void>();
  get isCancelled(): boolean {
    return this.cancelled;
  }
  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    for (const listener of this.listeners) listener();
    this.listeners.clear();
  }
  onCancel(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  throwIfCancelled(): void {
    if (this.cancelled) throw new CancelledError();
  }
}

function interruptibleSleep(ms: number, token: CancellationToken): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const off = token.onCancel(() => {
      clearTimeout(timer);
      cleanup();
      reject(new CancelledError());
    });
    function cleanup() {
      off();
    }
  });
}

export interface ExecuteOptions {
  /** Delay between edges so cancellation is observable and tests stay fast. */
  stepDelayMs?: number;
  now?: () => number;
}

/**
 * Runs every candidate path against one fixed sample. Paths run sequentially;
 * edge functions are bound to the snapshot revision passed in. Prior step
 * outputs are always retained when a later edge (or cancellation) stops a run.
 */
export async function executeExperiment(
  experiment: Experiment,
  paths: PathInfo[],
  edgesById: Map<string, MigrationEdge>,
  token: CancellationToken,
  options: ExecuteOptions = {}
): Promise<void> {
  const delay = options.stepDelayMs ?? 5;
  const now = options.now ?? Date.now;

  for (let pathIndex = 0; pathIndex < paths.length; pathIndex++) {
    const path = paths[pathIndex];
    const run: PathRun = {
      pathIndex,
      edgeIds: path.edgeIds,
      hops: path.hops,
      totalCost: path.totalCost,
      hasRollback: path.hasRollback,
      status: 'queued',
      steps: [],
    };
    experiment.runs.push(run);

    try {
      token.throwIfCancelled();
      run.status = 'running';
      let current: unknown = structuredClone(experiment.sample);

      for (const edgeId of path.edgeIds) {
        const edge = edgesById.get(edgeId);
        if (!edge) throw new Error(`snapshot is missing edge ${edgeId}`);
        token.throwIfCancelled();

        // Applicability condition is evaluated on the document at this point.
        const condition = evalCondition(edge.condition, current);
        if (!condition.ok) {
          const step: StepResult = {
            edgeId,
            fnRevision: edge.fn.revision,
            input: current,
            output: null,
            status: 'failed',
            stage: 'condition',
            error: condition.reason,
          };
          run.steps.push(step);
          run.status = 'failed';
          run.failedEdgeId = edgeId;
          run.error = `condition not met on edge ${edgeId}: ${condition.reason}`;
          break;
        }

        await interruptibleSleep(delay, token);
        token.throwIfCancelled();

        // Runtime validation checks the edge's declared output contract;
        // endpoint/node-schema compatibility is a static concern so that
        // partial compositions (edge a only knows id+email) remain runnable.
        const outcome = runMigration(edge.fn.body, current, edge.outputSchema);
        const step: StepResult = {
          edgeId,
          fnRevision: edge.fn.revision,
          input: current,
          output: outcome.ok ? outcome.output : null,
          status: outcome.ok ? 'ok' : 'failed',
          ...(outcome.ok ? {} : {stage: 'function' as const, error: outcome.error}),
        };
        run.steps.push(step);
        current = outcome.ok ? outcome.output : current;

        if (!outcome.ok) {
          run.status = 'failed';
          run.failedEdgeId = edgeId;
          run.error = `edge ${edgeId} failed: ${outcome.error}`;
          break;
        }
      }

      if (run.status === 'running') {
        run.status = 'succeeded';
        run.result = current;
      }
    } catch (error) {
      if (error instanceof CancelledError) {
        if (run.status === 'queued' || run.status === 'running') run.status = 'cancelled';
        // Any paths not yet started are marked cancelled as well.
        for (let i = pathIndex + 1; i < paths.length; i++) {
          const pending = paths[i];
          experiment.runs.push({
            pathIndex: i,
            edgeIds: pending.edgeIds,
            hops: pending.hops,
            totalCost: pending.totalCost,
            hasRollback: pending.hasRollback,
            status: 'cancelled',
            steps: [],
          });
        }
        experiment.status = 'cancelled';
        experiment.finishedAt = now();
        return;
      }
      throw error;
    }
  }

  experiment.status = 'completed';
  experiment.finishedAt = now();
}
