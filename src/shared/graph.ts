import {validateCondition} from './conditions';
import {checkFunctionBody} from './functions';
import {schemaSatisfies} from './schema';
import type {CycleInfo, EdgeIssue, MigrationEdge, MigrationGraph, PathInfo, RevisionNode} from './types';

const MAX_SIMPLE_PATHS = 64;

export function getNode(graph: MigrationGraph, id: string): RevisionNode | undefined {
  return graph.nodes.find(node => node.id === id);
}

export function getEdge(graph: MigrationGraph, id: string): MigrationEdge | undefined {
  return graph.edges.find(edge => edge.id === id);
}

/**
 * Static validation of one edge against the graph: endpoints exist, declared
 * input/output schemas line up with the endpoint node schemas, condition and
 * function body parse.
 */
export function validateEdge(graph: MigrationGraph, edge: MigrationEdge): EdgeIssue[] {
  const issues: EdgeIssue[] = [];
  const from = getNode(graph, edge.from);
  const to = getNode(graph, edge.to);

  if (!from)
    issues.push({code: 'missing_node', edgeId: edge.id, field: 'from', message: `source revision "${edge.from}" does not exist`});
  if (!to)
    issues.push({code: 'missing_node', edgeId: edge.id, field: 'to', message: `target revision "${edge.to}" does not exist`});
  if (from && to && edge.from === edge.to)
    issues.push({code: 'self_loop', edgeId: edge.id, message: 'edge starts and ends on the same revision'});
  if (from && !schemaSatisfies(from.schema, edge.inputSchema))
    issues.push({
      code: 'input_incompatible',
      edgeId: edge.id,
      field: 'inputSchema',
      message: `declared input requires fields not present on revision "${from.id}"`,
    });
  if (to && !schemaSatisfies(to.schema, edge.outputSchema))
    issues.push({
      code: 'output_incompatible',
      edgeId: edge.id,
      field: 'outputSchema',
      message: `declared output requires fields not present on revision "${to.id}"`,
    });
  if (!validateCondition(edge.condition))
    issues.push({code: 'bad_condition', edgeId: edge.id, field: 'condition', message: 'condition is not well-formed'});
  const bodyProblem = checkFunctionBody(edge.fn.body);
  if (bodyProblem)
    issues.push({code: 'bad_function', edgeId: edge.id, field: 'fn.body', message: `function does not compile: ${bodyProblem}`});
  return issues;
}

/** Enumerates simple paths (no repeated nodes). Back edges are allowed. */
export function enumeratePaths(graph: MigrationGraph, fromId: string, toId: string): PathInfo[] {
  const start = getNode(graph, fromId);
  const target = getNode(graph, toId);
  if (!start || !target) return [];

  const outgoing = new Map<string, MigrationEdge[]>();
  for (const edge of graph.edges) {
    const list = outgoing.get(edge.from) ?? [];
    list.push(edge);
    outgoing.set(edge.from, list);
  }

  const results: PathInfo[] = [];

  function walk(nodeId: string, nodeTrail: string[], edgeTrail: MigrationEdge[], cost: number) {
    if (nodeId === toId && edgeTrail.length > 0) {
      results.push(buildPath(graph, edgeTrail));
      return;
    }
    if (results.length >= MAX_SIMPLE_PATHS) return;
    for (const edge of outgoing.get(nodeId) ?? []) {
      if (nodeTrail.includes(edge.to)) continue; // simple paths only; cycles still detected separately
      walk(edge.to, [...nodeTrail, edge.to], [...edgeTrail, edge], cost + edge.cost);
      if (results.length >= MAX_SIMPLE_PATHS) return;
    }
  }

  if (fromId === toId) {
    results.push({edgeIds: [], nodeIds: [fromId], hops: 0, totalCost: 0, hasRollback: false, valid: true, issues: []});
  } else {
    walk(fromId, [fromId], [], 0);
  }

  // Cost first: the fewest-edge path is NOT assumed best. Ties break by hops
  // then lexical edge id so the ordering is stable across concurrent edits.
  results.sort((a, b) => a.totalCost - b.totalCost || a.hops - b.hops || a.edgeIds.join(',').localeCompare(b.edgeIds.join(',')));
  return results;
}

/** An edge moving toward an older revision order is a rollback (back) edge. */
export function isRollbackEdge(graph: MigrationGraph, edge: MigrationEdge): boolean {
  const from = getNode(graph, edge.from);
  const to = getNode(graph, edge.to);
  return !!from && !!to && to.order < from.order;
}

export function buildPath(graph: MigrationGraph, edgeTrail: MigrationEdge[]): PathInfo {
  const issues: EdgeIssue[] = [];
  let valid = true;

  // 1. Every edge validates on its own against endpoint schemas.
  for (const edge of edgeTrail) {
    const edgeIssues = validateEdge(graph, edge);
    if (edgeIssues.length) {
      valid = false;
      issues.push(...edgeIssues);
    }
  }

  // 2. Composition check: the output of each edge must satisfy the input of
  //    the next edge before they are composed.
  for (let i = 0; i < edgeTrail.length - 1; i++) {
    const current = edgeTrail[i];
    const next = edgeTrail[i + 1];
    if (!schemaSatisfies(current.outputSchema, next.inputSchema)) {
      valid = false;
      issues.push({
        code: 'chain_incompatible',
        edgeId: next.id,
        message: `output of "${current.id}" does not satisfy input of "${next.id}"`,
      });
    }
  }

  const hasRollback = edgeTrail.some(edge => isRollbackEdge(graph, edge));
  return {
    edgeIds: edgeTrail.map(edge => edge.id),
    nodeIds: [edgeTrail[0]?.from, ...edgeTrail.map(edge => edge.to)].filter(Boolean) as string[],
    hops: edgeTrail.length,
    totalCost: edgeTrail.reduce((sum, edge) => sum + edge.cost, 0),
    hasRollback,
    valid,
    issues,
  };
}

/** Only rollback edges whose forward migration is marked reversible are usable. */
export function rollbackUsable(graph: MigrationGraph, edge: MigrationEdge): boolean {
  if (!isRollbackEdge(graph, edge)) return false;
  const forward = graph.edges.find(candidate => candidate.from === edge.to && candidate.to === edge.from);
  return !!forward && forward.reversible;
}

/**
 * Cycle detection via DFS coloring. Back edges toward grey ancestors are
 * reported; cycles are allowed in the graph but surfaced to the user.
 */
export function detectCycles(graph: MigrationGraph): CycleInfo[] {
  const WHITE = 0, GREY = 1, BLACK = 2;
  const color = new Map<string, number>(graph.nodes.map(node => [node.id, WHITE]));
  const edgeStack: MigrationEdge[] = [];
  const nodeStack: string[] = [];
  const cycles: CycleInfo[] = [];
  const seen = new Set<string>();

  const outgoing = new Map<string, MigrationEdge[]>();
  for (const edge of graph.edges) {
    const list = outgoing.get(edge.from) ?? [];
    list.push(edge);
    outgoing.set(edge.from, list);
  }

  function visit(nodeId: string) {
    color.set(nodeId, GREY);
    nodeStack.push(nodeId);
    for (const edge of outgoing.get(nodeId) ?? []) {
      const neighbourColor = color.get(edge.to);
      if (neighbourColor === undefined) continue;
      if (neighbourColor === GREY) {
        const start = nodeStack.indexOf(edge.to);
        const cycleNodes = nodeStack.slice(start);
        // edgeStack[i] enters nodeStack[i+1], so slice(start) connects the
        // cycle nodes; the closing back edge itself is appended.
        const cycleEdges = [...edgeStack.slice(start), edge];
        const key = [...cycleNodes, edge.to].join('->') + ':' + cycleEdges.map(e => e.id).sort().join(',');
        if (!seen.has(key)) {
          seen.add(key);
          cycles.push({nodeIds: [...cycleNodes, edge.to], edgeIds: cycleEdges.map(e => e.id)});
        }
      } else if (neighbourColor === WHITE) {
        edgeStack.push(edge);
        visit(edge.to);
        edgeStack.pop();
      }
    }
    nodeStack.pop();
    color.set(nodeId, BLACK);
  }

  for (const node of graph.nodes) if (color.get(node.id) === WHITE) visit(node.id);
  return cycles;
}

/**
 * Candidate paths from start to target. `options.rollback` permits traversing
 * back edges, and only reversible ones are used. Invalid paths are still
 * returned (flagged) so the UI can show why they do not validate.
 */
export function findPaths(
  graph: MigrationGraph,
  fromId: string,
  toId: string,
  options: {rollback?: boolean} = {}
): PathInfo[] {
  const allowRollback = options.rollback ?? false;
  const paths = enumeratePaths(graph, fromId, toId);
  return paths
    .map(path => {
      if (!path.hasRollback) return path;
      if (!allowRollback) return path; // dropped by the filter below
      const blocked = path.edgeIds
        .map(id => getEdge(graph, id)!)
        .find(edge => isRollbackEdge(graph, edge) && !rollbackUsable(graph, edge));
      if (!blocked) return path;
      return {
        ...path,
        valid: false,
        issues: [
          ...path.issues,
          {
            code: 'rollback_not_reversible' as const,
            edgeId: blocked.id,
            message: `rollback edge "${blocked.id}" is blocked: its forward migration is not marked reversible`,
          },
        ],
      };
    })
    .filter(path => !path.hasRollback || allowRollback);
}
