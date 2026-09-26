import express, {type Express} from 'express';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {validateCondition} from '../shared/conditions';
import {buildPath, detectCycles, findPaths, getEdge, validateEdge} from '../shared/graph';
import type {
  Condition,
  Experiment,
  FieldType,
  MigrationEdge,
  MigrationGraph,
  PathInfo,
  Sample,
  SchemaDef,
} from '../shared/types';
import {CancellationToken, executeExperiment} from './runner';
import {seedGraph, seedSamples} from './seed';

const MAX_EXPERIMENTS = 50;

interface StoredExperiment {
  experiment: Experiment;
  token: CancellationToken;
}

export interface CreateAppOptions {
  stepDelayMs?: number;
}

function isFieldType(value: unknown): value is FieldType {
  return value === 'string' || value === 'number' || value === 'boolean';
}

function parseSchema(value: unknown): SchemaDef | string {
  if (!value || typeof value !== 'object' || !Array.isArray((value as SchemaDef).fields))
    return 'schema must be {fields: [...]}';
  for (const field of (value as SchemaDef).fields) {
    if (!field || typeof field.name !== 'string' || !field.name) return 'every field needs a name';
    if (!isFieldType(field.type)) return `field "${field.name}" has an invalid type`;
  }
  return value as SchemaDef;
}

export function createApp(options: CreateAppOptions = {}): Express {
  const graph: MigrationGraph = seedGraph();
  const samples: Sample[] = seedSamples();
  const experiments = new Map<string, StoredExperiment>();

  function graphView() {
    return {
      graph,
      cycles: detectCycles(graph),
      edgeIssues: graph.edges.map(edge => ({edgeId: edge.id, issues: validateEdge(graph, edge)})),
      samples,
    };
  }

  function touchGraph() {
    graph.revision += 1;
  }

  function recordExperiment(record: StoredExperiment) {
    experiments.set(record.experiment.id, record);
    const ids = [...experiments.keys()];
    if (ids.length > MAX_EXPERIMENTS) experiments.delete(ids[0]);
  }

  function snapshotEdges(paths: PathInfo[]): Map<string, MigrationEdge> {
    // Bind the exact edge + function revision seen at execution start.
    const snapshot = new Map<string, MigrationEdge>();
    for (const path of paths) {
      for (const edgeId of path.edgeIds) {
        if (!snapshot.has(edgeId)) {
          const edge = getEdge(graph, edgeId);
          if (edge) snapshot.set(edgeId, structuredClone(edge));
        }
      }
    }
    return snapshot;
  }

  const app = express();
  app.use(express.json({limit: '1mb'}));

  app.get('/api/health', (_req, res) => res.json({ok: true}));

  app.get('/api/graph', (_req, res) => {
    res.set('ETag', String(graph.revision)).json(graphView());
  });

  app.put('/api/edges/:id', (req, res) => {
    const edge = getEdge(graph, req.params.id);
    if (!edge) return res.status(404).json({error: 'not_found'});

    const expected = Number(req.body.revision);
    if (!Number.isFinite(expected)) return res.status(400).json({error: 'revision_required'});
    if (expected !== graph.revision)
      return res.status(409).json({error: 'revision_conflict', currentRevision: graph.revision});

    if (req.body.cost !== undefined) {
      const cost = Number(req.body.cost);
      if (!Number.isFinite(cost) || cost < 0) return res.status(400).json({error: 'invalid_cost'});
      edge.cost = cost;
    }
    if (req.body.reversible !== undefined) {
      if (typeof req.body.reversible !== 'boolean') return res.status(400).json({error: 'invalid_reversible'});
      edge.reversible = req.body.reversible;
    }
    if (req.body.condition !== undefined) {
      if (!validateCondition(req.body.condition)) return res.status(400).json({error: 'invalid_condition'});
      edge.condition = req.body.condition as Condition;
    }
    if (req.body.inputSchema !== undefined) {
      const parsed = parseSchema(req.body.inputSchema);
      if (typeof parsed === 'string') return res.status(400).json({error: parsed});
      edge.inputSchema = parsed;
    }
    if (req.body.outputSchema !== undefined) {
      const parsed = parseSchema(req.body.outputSchema);
      if (typeof parsed === 'string') return res.status(400).json({error: parsed});
      edge.outputSchema = parsed;
    }
    if (req.body.body !== undefined) {
      if (typeof req.body.body !== 'string' || !req.body.body.trim())
        return res.status(400).json({error: 'invalid_body'});
      edge.fn = {
        body: req.body.body,
        revision: edge.fn.revision + 1,
        updatedAt: new Date().toISOString(),
      };
    }

    touchGraph();
    res.json(graphView());
  });

  app.post('/api/edges', (req, res) => {
    const expected = Number(req.body.revision);
    if (!Number.isFinite(expected)) return res.status(400).json({error: 'revision_required'});
    if (expected !== graph.revision)
      return res.status(409).json({error: 'revision_conflict', currentRevision: graph.revision});

    const id = String(req.body.id ?? '').trim();
    if (!/^[a-z0-9_-]+$/i.test(id)) return res.status(400).json({error: 'invalid_id'});
    if (getEdge(graph, id)) return res.status(409).json({error: 'edge_exists'});
    const from = String(req.body.from ?? '');
    const to = String(req.body.to ?? '');
    if (!graph.nodes.some(node => node.id === from) || !graph.nodes.some(node => node.id === to))
      return res.status(400).json({error: 'unknown_node'});
    const cost = Number(req.body.cost ?? 1);
    if (!Number.isFinite(cost) || cost < 0) return res.status(400).json({error: 'invalid_cost'});
    if (!validateCondition(req.body.condition)) return res.status(400).json({error: 'invalid_condition'});
    const inputSchema = parseSchema(req.body.inputSchema);
    if (typeof inputSchema === 'string') return res.status(400).json({error: inputSchema});
    const outputSchema = parseSchema(req.body.outputSchema);
    if (typeof outputSchema === 'string') return res.status(400).json({error: outputSchema});
    const body = typeof req.body.body === 'string' ? req.body.body : 'return doc;';

    const edge: MigrationEdge = {
      id,
      from,
      to,
      cost,
      reversible: req.body.reversible === true,
      condition: req.body.condition as Condition,
      inputSchema,
      outputSchema,
      fn: {body, revision: 1, updatedAt: new Date().toISOString()},
    };
    graph.edges.push(edge);
    touchGraph();
    res.status(201).json(graphView());
  });

  app.delete('/api/edges/:id', (req, res) => {
    const expected = Number(req.body.revision);
    if (!Number.isFinite(expected)) return res.status(400).json({error: 'revision_required'});
    if (expected !== graph.revision)
      return res.status(409).json({error: 'revision_conflict', currentRevision: graph.revision});
    const index = graph.edges.findIndex(edge => edge.id === req.params.id);
    if (index < 0) return res.status(404).json({error: 'not_found'});
    graph.edges.splice(index, 1);
    touchGraph();
    res.json(graphView());
  });

  // Candidate paths for any start/target pair. Never assumes fewest edges is
  // best: results are ordered by total declared cost.
  app.get('/api/paths', (req, res) => {
    const from = String(req.query.from ?? '');
    const to = String(req.query.to ?? '');
    const allowRollback = String(req.query.rollback ?? 'false') === 'true';
    if (!graph.nodes.some(node => node.id === from) || !graph.nodes.some(node => node.id === to))
      return res.status(400).json({error: 'unknown_node'});

    const paths = findPaths(graph, from, to, {rollback: allowRollback});
    res.json({
      graphRevision: graph.revision,
      from,
      to,
      rollback: allowRollback,
      paths,
      cycles: detectCycles(graph),
    });
  });

  // Validate one edge sequence as a composition without running functions.
  app.post('/api/compose/validate', (req, res) => {
    const edgeIds = Array.isArray(req.body.edgeIds) ? (req.body.edgeIds as unknown[]) : [];
    const edges: MigrationEdge[] = [];
    for (const id of edgeIds) {
      const edge = typeof id === 'string' ? getEdge(graph, id) : undefined;
      if (!edge) return res.status(404).json({error: `edge ${String(id)} not found`});
      edges.push(edge);
    }
    if (edges.length === 0) return res.status(400).json({error: 'empty_path'});
    res.json(buildPath(graph, edges));
  });

  // Start an experiment: compare every candidate path on one fixed sample.
  app.post('/api/experiments', async (req, res) => {
    const from = String(req.body.from ?? '');
    const to = String(req.body.to ?? '');
    const allowRollback = req.body.rollback === true;
    if (!graph.nodes.some(node => node.id === from) || !graph.nodes.some(node => node.id === to))
      return res.status(400).json({error: 'unknown_node'});

    // The plan was made against a specific graph revision; concurrent edits
    // invalidate it and force the client to replan.
    const expectedRevision = Number(req.body.expectedRevision);
    if (Number.isFinite(expectedRevision) && expectedRevision !== graph.revision)
      return res.status(409).json({error: 'revision_conflict', currentRevision: graph.revision});

    let paths: PathInfo[];
    if (Array.isArray(req.body.paths) && req.body.paths.length > 0) {
      paths = [];
      for (const sequence of req.body.paths) {
        if (!Array.isArray(sequence)) return res.status(400).json({error: 'invalid_path'});
        const edges: MigrationEdge[] = [];
        for (const id of sequence) {
          const edge = typeof id === 'string' ? getEdge(graph, id) : undefined;
          if (!edge) return res.status(409).json({error: 'graph_changed', currentRevision: graph.revision});
          edges.push(edge);
        }
        const built = buildPath(graph, edges);
        if (built.nodeIds[0] !== from || built.nodeIds[built.nodeIds.length - 1] !== to)
          return res.status(400).json({error: 'path_endpoints_mismatch'});
        if (!allowRollback && built.hasRollback) return res.status(400).json({error: 'rollback_not_allowed'});
        paths.push(built);
      }
      // Preserve cost-first ordering for stable display and run order.
      paths.sort(
        (a, b) => a.totalCost - b.totalCost || a.hops - b.hops || a.edgeIds.join(',').localeCompare(b.edgeIds.join(','))
      );
    } else {
      paths = findPaths(graph, from, to, {rollback: allowRollback});
    }

    let sampleDoc: unknown;
    let sampleId: string | null = null;
    if (req.body.sampleId !== undefined && req.body.sampleId !== null) {
      const sample = samples.find(candidate => candidate.id === req.body.sampleId);
      if (!sample) return res.status(400).json({error: 'unknown_sample'});
      sampleId = sample.id;
      sampleDoc = structuredClone(sample.doc);
    } else if (req.body.sample !== undefined) {
      sampleDoc = req.body.sample;
    } else {
      return res.status(400).json({error: 'sample_required'});
    }

    const edgesById = snapshotEdges(paths);
    const experiment: Experiment = {
      id: randomUUID(),
      graphRevision: graph.revision,
      sampleId,
      sample: structuredClone(sampleDoc),
      status: 'running',
      createdAt: Date.now(),
      runs: [],
    };
    const token = new CancellationToken();
    recordExperiment({experiment, token});
    res.status(202).json({
      id: experiment.id,
      graphRevision: experiment.graphRevision,
      paths: paths.map((path, index) => ({pathIndex: index, ...path})),
    });

    // Fire-and-forget; clients poll the experiment resource. The bound
    // snapshot means later edits/function updates cannot affect this run.
    void executeExperiment(experiment, paths, edgesById, token, {stepDelayMs: options.stepDelayMs}).catch(error => {
      if (token.isCancelled) {
        experiment.status = 'cancelled';
      } else {
        experiment.status = 'failed';
        console.error('experiment failed', error);
      }
      experiment.finishedAt = Date.now();
    });
  });

  app.get('/api/experiments/:id', (req, res) => {
    const stored = experiments.get(req.params.id);
    if (!stored) return res.status(404).json({error: 'not_found'});
    res.json(stored.experiment);
  });

  app.post('/api/experiments/:id/cancel', (req, res) => {
    const stored = experiments.get(req.params.id);
    if (!stored) return res.status(404).json({error: 'not_found'});
    stored.token.cancel();
    res.json({id: stored.experiment.id, status: 'cancelling'});
  });

  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createApp().listen(4174, '127.0.0.1', () => console.log('server http://127.0.0.1:4174'));
}
