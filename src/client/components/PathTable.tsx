import {AlertTriangle, CheckCircle2, GitBranch, Undo2} from 'lucide-react';
import type {PathInfo} from '../../shared/types';

interface Props {
  paths: PathInfo[];
  selectedPathKeys: Set<string>;
  onTogglePath: (key: string) => void;
  graphRevision: number;
}

export function pathKey(path: PathInfo): string {
  return path.edgeIds.join(',');
}

export function PathTable({paths, selectedPathKeys, onTogglePath, graphRevision}: Props) {
  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Candidate paths</h2>
        <span className="pill">graph rev {graphRevision}</span>
      </div>
      <p className="hint">
        Ordered by total migration cost, not edge count. Tick paths to include in the fixed-sample comparison.
      </p>
      {paths.length === 0 ? (
        <p className="empty">No paths for this pair. Try enabling rollback edges.</p>
      ) : (
        <table className="paths">
          <thead>
            <tr>
              <th />
              <th>Route</th>
              <th className="num">Cost</th>
              <th className="num">Hops</th>
              <th>Flags</th>
              <th>Validation</th>
            </tr>
          </thead>
          <tbody>
            {paths.map((path, index) => {
              const key = pathKey(path);
              return (
                <tr key={key} className={path.valid ? '' : 'invalid-row'}>
                  <td>
                    <input
                      type="checkbox"
                      checked={selectedPathKeys.has(key)}
                      disabled={!path.valid}
                      onChange={() => onTogglePath(key)}
                      aria-label={`select path ${key}`}
                    />
                  </td>
                  <td>
                    <span className="route">
                      {path.nodeIds.map((nodeId, nodeIndex) => (
                        <span key={`${nodeId}-${nodeIndex}`}>
                          {nodeIndex > 0 && <span className="arrow">→</span>}
                          <span className="node">{nodeId}</span>
                        </span>
                      ))}
                    </span>
                    {index === 0 && path.valid && <span className="badge best">cheapest</span>}
                  </td>
                  <td className="num strong">{path.totalCost}</td>
                  <td className="num">{path.hops}</td>
                  <td>
                    {path.hasRollback && (
                      <span className="badge rollback" title="contains an edge back to an older revision">
                        <Undo2 size={12} /> rollback
                      </span>
                    )}
                    {index === 0 && path.valid && path.hops > Math.min(...paths.map(p => p.hops)) && (
                      <span className="badge note" title="fewer-edge paths exist but cost more">
                        <GitBranch size={12} /> not fewest hops
                      </span>
                    )}
                  </td>
                  <td>
                    {path.valid ? (
                      <span className="ok">
                        <CheckCircle2 size={14} /> valid
                      </span>
                    ) : (
                      <div className="issues">
                        {path.issues.slice(0, 3).map((issue, issueIndex) => (
                          <span key={issueIndex} className="issue" title={issue.message}>
                            <AlertTriangle size={12} /> {issue.code}
                            {issue.edgeId ? ` (${issue.edgeId})` : ''}
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
