import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {FlaskConical, Play, RefreshCw, Undo2, AlertTriangle} from 'lucide-react';
import {api, ApiError, type GraphView, type PathsResponse} from './api';
import {PathTable, pathKey} from './components/PathTable';
import {EdgeEditor} from './components/EdgeEditor';
import {ResultPanel} from './components/ResultPanel';
import {isStaleExperiment} from './guards';
import type {Experiment, MigrationEdge} from '../shared/types';

export default function App() {
  const [view, setView] = useState<GraphView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [from, setFrom] = useState('v1');
  const [to, setTo] = useState('v4');
  const [allowRollback, setAllowRollback] = useState(false);
  const [sampleId, setSampleId] = useState('modern');
  const [pathsResponse, setPathsResponse] = useState<PathsResponse | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const [experiment, setExperiment] = useState<Experiment | null>(null);
  const [running, setRunning] = useState(false);
  const [action, setAction] = useState('Ready');

  // Monotonic guard: completion of an old experiment must never overwrite a
  // newer one the user has started.
  const experimentIdRef = useRef<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reloadGraph = useCallback(async () => {
    const fresh = await api.graph();
    setView(fresh);
    return fresh;
  }, []);

  useEffect(() => {
    reloadGraph().catch(err => setError(String(err)));
  }, [reloadGraph]);

  const loadPaths = useCallback(
    async (graphRevision?: number) => {
      const response = await api.paths(from, to, allowRollback);
      setPathsResponse(response);
      // Default selection: every valid path, so comparison includes equivalents.
      setSelectedPaths(new Set(response.paths.filter(path => path.valid).map(pathKey)));
      if (graphRevision !== undefined && response.graphRevision !== graphRevision) {
        setError('Graph changed while planning — reloaded candidates.');
      }
    },
    [from, to, allowRollback]
  );

  useEffect(() => {
    loadPaths().catch(err => setError(err instanceof Error ? err.message : String(err)));
  }, [loadPaths]);

  const edgeById = useMemo(() => {
    const map = new Map<string, MigrationEdge>();
    view?.graph.edges.forEach(edge => map.set(edge.id, edge));
    return map;
  }, [view]);

  const selectedEdgeObj = selectedEdge ? edgeById.get(selectedEdge) ?? null : null;
  const selectedEdgeIssues = view?.edgeIssues.find(entry => entry.edgeId === selectedEdge);

  const stopPolling = () => {
    if (pollRef.current) {
      clearTimeout(pollRef.current);
      pollRef.current = null;
    }
  };

  const poll = useCallback((id: string) => {
    stopPolling();
    const tick = async () => {
      try {
        const fresh = await api.experiment(id);
        if (isStaleExperiment(experimentIdRef.current, id)) return; // old run finished late
        setExperiment(fresh);
        if (fresh.status === 'running') {
          pollRef.current = setTimeout(tick, 150);
        } else {
          setRunning(false);
          setAction(fresh.status === 'cancelled' ? 'Cancelled' : fresh.status === 'failed' ? 'Failed' : 'Completed');
        }
      } catch (err) {
        if (!isStaleExperiment(experimentIdRef.current, id)) {
          setError(err instanceof Error ? err.message : String(err));
          setRunning(false);
        }
      }
    };
    pollRef.current = setTimeout(tick, 120);
  }, []);

  useEffect(() => stopPolling, []);

  async function runComparison() {
    if (!pathsResponse) return;
    setError(null);
    setAction('Starting experiment…');
    try {
      const chosen = pathsResponse.paths
        .filter(path => selectedPaths.has(pathKey(path)))
        .map(path => path.edgeIds);
      const started = await api.startExperiment({
        from,
        to,
        rollback: allowRollback,
        sampleId,
        expectedRevision: pathsResponse.graphRevision,
        paths: chosen,
      });
      experimentIdRef.current = started.id; // older completions are now stale
      setRunning(true);
      setAction('Running');
      setExperiment({
        id: started.id,
        graphRevision: started.graphRevision,
        sampleId,
        sample: view?.samples.find(sample => sample.id === sampleId)?.doc ?? null,
        status: 'running',
        createdAt: Date.now(),
        runs: [],
      });
      poll(started.id);
    } catch (err) {
      if (err instanceof ApiError && (err.status === 409 || err.message === 'graph_changed')) {
        setError('The migration graph changed since this plan was shown. Replan and run again.');
        await loadPaths();
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
      setRunning(false);
      setAction('Ready');
    }
  }

  async function cancel() {
    const id = experimentIdRef.current;
    if (!id) return;
    setAction('Cancelling…');
    try {
      await api.cancel(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleEdgeSave(id: string, revision: number, patch: Record<string, unknown>) {
    await api.updateEdge(id, revision, patch);
    const fresh = await reloadGraph();
    await loadPaths(fresh.graph.revision);
  }

  const cycles = view?.cycles ?? [];

  return (
    <main className="shell">
      <header className="topbar">
        <FlaskConical size={20} />
        <strong>Schema Evolution Studio</strong>
        <small>migration paths · fixed-sample comparison</small>
        <span className="topbar-rev">{action}</span>
      </header>

      <section className="controls panel">
        <label>
          From
          <select value={from} onChange={event => setFrom(event.target.value)}>
            {view?.graph.nodes.map(node => (
              <option key={node.id} value={node.id}>
                {node.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          To
          <select value={to} onChange={event => setTo(event.target.value)}>
            {view?.graph.nodes.map(node => (
              <option key={node.id} value={node.id}>
                {node.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Fixed sample
          <select value={sampleId} onChange={event => setSampleId(event.target.value)}>
            {view?.samples.map(sample => (
              <option key={sample.id} value={sample.id}>
                {sample.name}
              </option>
            ))}
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={allowRollback} onChange={event => setAllowRollback(event.target.checked)} />
          <Undo2 size={14} /> allow rollback edges
        </label>
        <button className="primary" onClick={runComparison} disabled={running || selectedPaths.size === 0}>
          <Play size={14} /> compare {selectedPaths.size} path{selectedPaths.size === 1 ? '' : 's'}
        </button>
        <button
          onClick={() => loadPaths().catch(err => setError(String(err)))}
          title="reload candidates"
        >
          <RefreshCw size={14} />
        </button>
        {cycles.length > 0 && (
          <span className="cycle-warning" title={cycles.map(c => c.nodeIds.join('→')).join('\n')}>
            <AlertTriangle size={14} /> {cycles.length} cycle{cycles.length === 1 ? '' : 's'} present (back edges allowed)
          </span>
        )}
        {error && <span className="banner-error">{error}</span>}
      </section>

      <section className="workspace-3col">
        <div className="column">
          {pathsResponse && (
            <PathTable
              paths={pathsResponse.paths}
              selectedPathKeys={selectedPaths}
              onTogglePath={key =>
                setSelectedPaths(previous => {
                  const next = new Set(previous);
                  if (next.has(key)) next.delete(key);
                  else next.add(key);
                  return next;
                })
              }
              graphRevision={pathsResponse.graphRevision}
            />
          )}
          <div className="panel">
            <div className="panel-head">
              <h2>Edges</h2>
            </div>
            <div className="edge-list">
              {view?.graph.edges.map(edge => {
                const issues = view.edgeIssues.find(entry => entry.edgeId === edge.id);
                return (
                  <button
                    key={edge.id}
                    className={`edge-row ${selectedEdge === edge.id ? 'active' : ''}`}
                    onClick={() => setSelectedEdge(edge.id)}
                  >
                    <code>{edge.id}</code>
                    <span>
                      {edge.from}→{edge.to}
                    </span>
                    <span className="muted">cost {edge.cost} · fn r{edge.fn.revision}</span>
                    {edge.reversible && <span className="tag">rev</span>}
                    {issues && issues.issues.length > 0 && (
                      <span className="tag bad">
                        <AlertTriangle size={11} /> {issues.issues.length}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div className="column">
          <ResultPanel experiment={experiment} onCancel={cancel} />
        </div>

        <div className="column">
          <EdgeEditor
            edge={selectedEdgeObj}
            graphRevision={view?.graph.revision ?? 0}
            issues={selectedEdgeIssues}
            onSave={handleEdgeSave}
            onSaved={() => setAction('Edge updated — replan to see new costs/results')}
          />
        </div>
      </section>
    </main>
  );
}
