import type {Experiment, PathInfo} from '../shared/types';

export interface EdgeIssueView {
  edgeId: string;
  issues: {code: string; message: string; field?: string}[];
}

export interface GraphView {
  graph: {
    nodes: import('../shared/types').RevisionNode[];
    edges: import('../shared/types').MigrationEdge[];
    revision: number;
  };
  cycles: {nodeIds: string[]; edgeIds: string[]}[];
  edgeIssues: EdgeIssueView[];
  samples: {id: string; name: string; doc: unknown}[];
}

export interface PathsResponse {
  graphRevision: number;
  from: string;
  to: string;
  rollback: boolean;
  paths: PathInfo[];
  cycles: {nodeIds: string[]; edgeIds: string[]}[];
}

export interface StartedExperiment {
  id: string;
  graphRevision: number;
  paths: (PathInfo & {pathIndex: number})[];
}

async function parse(response: Response): Promise<unknown> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status, body);
  return body;
}

export class ApiError extends Error {
  status: number;
  body: {error?: string; currentRevision?: number};
  constructor(status: number, body: {error?: string; currentRevision?: number}) {
    super(body.error ?? `request failed (${status})`);
    this.status = status;
    this.body = body;
  }
  get conflict(): boolean {
    return this.status === 409;
  }
}

export const api = {
  async graph(): Promise<GraphView> {
    return (await parse(await fetch('/api/graph'))) as GraphView;
  },

  async paths(from: string, to: string, rollback: boolean): Promise<PathsResponse> {
    const params = new URLSearchParams({from, to, rollback: String(rollback)});
    return (await parse(await fetch(`/api/paths?${params}`))) as PathsResponse;
  },

  async updateEdge(
    id: string,
    revision: number,
    patch: Record<string, unknown>
  ): Promise<GraphView> {
    return (await parse(
      await fetch(`/api/edges/${id}`, {
        method: 'PUT',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({revision, ...patch}),
      })
    )) as GraphView;
  },

  async startExperiment(payload: {
    from: string;
    to: string;
    rollback: boolean;
    sampleId?: string;
    sample?: unknown;
    expectedRevision: number;
    paths?: string[][];
  }): Promise<StartedExperiment> {
    return (await parse(
      await fetch('/api/experiments', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify(payload),
      })
    )) as StartedExperiment;
  },

  async experiment(id: string): Promise<Experiment> {
    return (await parse(await fetch(`/api/experiments/${id}`))) as Experiment;
  },

  async cancel(id: string): Promise<void> {
    await parse(await fetch(`/api/experiments/${id}/cancel`, {method: 'POST'}));
  },
};
