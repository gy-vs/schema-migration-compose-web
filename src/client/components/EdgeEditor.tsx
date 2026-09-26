import {useEffect, useState} from 'react';
import {Save, RefreshCw} from 'lucide-react';
import {describeCondition} from '../../shared/conditions';
import {checkFunctionBody} from '../../shared/functions';
import type {Condition, MigrationEdge} from '../../shared/types';
import type {EdgeIssueView} from '../api';
import {ApiError} from '../api';

interface Props {
  edge: MigrationEdge | null;
  graphRevision: number;
  issues: EdgeIssueView | undefined;
  onSave: (id: string, revision: number, patch: Record<string, unknown>) => Promise<unknown>;
  onSaved: () => void;
}

export function EdgeEditor({edge, graphRevision, issues, onSave, onSaved}: Props) {
  const [cost, setCost] = useState('');
  const [reversible, setReversible] = useState(false);
  const [condition, setCondition] = useState<Condition>({kind: 'always'});
  const [body, setBody] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{kind: 'ok' | 'error' | 'conflict'; text: string} | null>(null);

  useEffect(() => {
    if (edge) {
      setCost(String(edge.cost));
      setReversible(edge.reversible);
      setCondition(edge.condition);
      setBody(edge.fn.body);
      setMessage(null);
    }
  }, [edge]);

  if (!edge) {
    return (
      <div className="panel edge-editor">
        <div className="panel-head">
          <h2>Edge</h2>
        </div>
        <p className="empty">Select an edge to inspect its migration function.</p>
      </div>
    );
  }

  const bodyProblem = checkFunctionBody(body);

  async function save() {
    if (!edge) return;
    setSaving(true);
    setMessage(null);
    try {
      await onSave(edge.id, graphRevision, {
        cost: Number(cost),
        reversible,
        condition,
        body,
      });
      // The parent reloads the graph and bumps the bound revision.
      setMessage({kind: 'ok', text: `Saved — function becomes revision ${edge.fn.revision + 1}`});
      onSaved();
    } catch (error) {
      if (error instanceof ApiError && error.conflict) {
        setMessage({
          kind: 'conflict',
          text: `Graph was edited concurrently (now rev ${error.body.currentRevision}). Reload and retry.`,
        });
      } else {
        setMessage({kind: 'error', text: error instanceof Error ? error.message : 'save failed'});
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="panel edge-editor">
      <div className="panel-head">
        <h2>
          Edge <code>{edge.id}</code>
        </h2>
        <span className="pill">
          {edge.from} → {edge.to} · fn rev {edge.fn.revision}
        </span>
      </div>

      {issues && issues.issues.length > 0 && (
        <div className="issue-box">
          {issues.issues.map((issue, index) => (
            <div key={index} className="issue">
              {issue.code}: {issue.message}
            </div>
          ))}
        </div>
      )}

      <div className="form-grid">
        <label>
          Cost
          <input type="number" min={0} value={cost} onChange={event => setCost(event.target.value)} />
        </label>
        <label className="check">
          <input type="checkbox" checked={reversible} onChange={event => setReversible(event.target.checked)} />
          reversible forward migration
        </label>
      </div>

      <label className="block">
        Applicability condition
        <select
          value={condition.kind}
          onChange={event => {
            const kind = event.target.value;
            if (kind === 'always') setCondition({kind: 'always'});
            else if (kind === 'fieldExists') setCondition({kind: 'fieldExists', field: 'fieldName'});
            else setCondition({kind: 'fieldEquals', field: 'fieldName', value: ''});
          }}
        >
          <option value="always">always</option>
          <option value="fieldExists">field exists</option>
          <option value="fieldEquals">field equals</option>
        </select>
      </label>
      {condition.kind !== 'always' && (
        <div className="form-grid">
          <label className="block">
            Field
            <input
              value={condition.field}
              onChange={event =>
                setCondition(
                  condition.kind === 'fieldExists'
                    ? {kind: 'fieldExists', field: event.target.value}
                    : {kind: 'fieldEquals', field: event.target.value, value: condition.value}
                )
              }
            />
          </label>
          {condition.kind === 'fieldEquals' && (
            <label className="block">
              Value (string)
              <input
                value={String(condition.value)}
                onChange={event => setCondition({kind: 'fieldEquals', field: condition.field, value: event.target.value})}
              />
            </label>
          )}
        </div>
      )}
      <p className="hint">Evaluates at runtime: {describeCondition(condition)}</p>

      <label className="block">
        Function body <code>(doc) =&gt; &#123; … &#125;</code>
        <textarea rows={8} value={body} onChange={event => setBody(event.target.value)} spellCheck={false} />
      </label>
      {bodyProblem && <div className="issue-box">compile error: {bodyProblem}</div>}

      <div className="toolbar">
        <button className="primary" onClick={save} disabled={saving || !!bodyProblem}>
          {saving ? <RefreshCw size={14} className="spin" /> : <Save size={14} />}
          Save new revision
        </button>
        {message && <span className={`save-msg ${message.kind}`}>{message.text}</span>}
      </div>
    </div>
  );
}
