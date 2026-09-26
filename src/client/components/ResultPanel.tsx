import {Ban, CheckCircle2, CircleDashed, Loader2, XCircle} from 'lucide-react';
import type {Experiment, PathRun} from '../../shared/types';
import {summarizeRuns} from '../guards';

const STATUS_ICON = {
  queued: <CircleDashed size={14} />,
  running: <Loader2 size={14} className="spin" />,
  succeeded: <CheckCircle2 size={14} />,
  failed: <XCircle size={14} />,
  cancelled: <Ban size={14} />,
} as const;

function RunCard({run}: {run: PathRun}) {
  return (
    <div className={`run-card ${run.status}`}>
      <div className="run-head">
        <span className={`run-status ${run.status}`}>
          {STATUS_ICON[run.status]} {run.status}
        </span>
        <code>{run.edgeIds.join(' → ') || '(no edges)'}</code>
        <span className="run-cost">
          cost <strong>{run.totalCost}</strong> · {run.hops} hop{run.hops === 1 ? '' : 's'}
          {run.hasRollback && ' · rollback'}
        </span>
      </div>
      {run.failedEdgeId && (
        <p className="run-error">
          stopped at edge <code>{run.failedEdgeId}</code>: {run.error}
        </p>
      )}
      {run.steps.length > 0 && (
        <ol className="steps">
          {run.steps.map((step, index) => (
            <li key={index} className={`step ${step.status}`}>
              <div className="step-line">
                <code>{step.edgeId}</code>
                <span className="muted">fn rev {step.fnRevision}</span>
                <span className={`step-state ${step.status}`}>
                  {step.status === 'ok' ? 'ok' : `${step.status} · ${step.stage}`}
                </span>
              </div>
              {step.error && <pre className="step-error">{step.error}</pre>}
              <details>
                <summary>intermediate document</summary>
                <pre>{JSON.stringify(step.status === 'ok' ? step.output : step.input, null, 2)}</pre>
              </details>
            </li>
          ))}
        </ol>
      )}
      {run.status === 'succeeded' && (
        <details className="final" open>
          <summary>final result</summary>
          <pre>{JSON.stringify(run.result, null, 2)}</pre>
        </details>
      )}
    </div>
  );
}

interface Props {
  experiment: Experiment | null;
  onCancel: () => void;
}

export function ResultPanel({experiment, onCancel}: Props) {
  if (!experiment) {
    return (
      <div className="panel">
        <div className="panel-head">
          <h2>Comparison</h2>
        </div>
        <p className="empty">Choose a start and target revision, pick a fixed sample, then run.</p>
      </div>
    );
  }

  const summaries = summarizeRuns(experiment);
  const succeeded = summaries.filter(run => run.status === 'succeeded');
  const distinctResults = new Set(succeeded.map(run => JSON.stringify(run.result)));
  const running = experiment.status === 'running';

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Comparison</h2>
        <span className={`pill exp-status ${experiment.status}`}>{experiment.status}</span>
      </div>
      <p className="hint">
        experiment <code>{experiment.id.slice(0, 8)}</code> · bound to graph rev {experiment.graphRevision}
      </p>
      {running && (
        <button className="danger" onClick={onCancel}>
          <Ban size={14} /> cancel execution
        </button>
      )}
      {!running && (
        <p className="summary-line">
          {succeeded.length} succeeded · {distinctResults.size} distinct result
          {distinctResults.size === 1 ? '' : 's'} on the same sample
          {distinctResults.size === 1 && succeeded.length > 1 && ' — paths are equivalent'}
        </p>
      )}
      <div className="runs">
        {[...experiment.runs]
          .sort((a, b) => a.pathIndex - b.pathIndex)
          .map(run => (
            <RunCard key={run.pathIndex} run={run} />
          ))}
      </div>
    </div>
  );
}
