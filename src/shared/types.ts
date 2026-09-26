// Core domain types shared by server and client.

export type FieldType = 'string' | 'number' | 'boolean';

export interface FieldDef {
  name: string;
  type: FieldType;
  required?: boolean;
}

export interface SchemaDef {
  fields: FieldDef[];
}

/** Declarative applicability condition attached to a migration edge. */
export type Condition =
  | {kind: 'always'}
  | {kind: 'fieldExists'; field: string}
  | {kind: 'fieldEquals'; field: string; value: string | number | boolean};

export interface FunctionDef {
  /** Body of a synchronous `(doc) => ...` function. */
  body: string;
  /** Bumped whenever the body changes; experiments bind the revision at execution. */
  revision: number;
  updatedAt: string;
}

export interface RevisionNode {
  id: string;
  name: string;
  /** Monotonic version order; an edge toward a lower order is a rollback edge. */
  order: number;
  schema: SchemaDef;
}

export type EdgeIssueCode =
  | 'missing_node'
  | 'self_loop'
  | 'input_incompatible'
  | 'output_incompatible'
  | 'chain_incompatible'
  | 'rollback_not_reversible'
  | 'bad_condition'
  | 'bad_function';

export interface EdgeIssue {
  code: EdgeIssueCode;
  edgeId: string;
  message: string;
  field?: string;
}

export interface MigrationEdge {
  id: string;
  from: string;
  to: string;
  cost: number;
  /** Marks the forward migration as safely reversible (drives rollback planning). */
  reversible: boolean;
  condition: Condition;
  inputSchema: SchemaDef;
  outputSchema: SchemaDef;
  fn: FunctionDef;
}

export interface MigrationGraph {
  nodes: RevisionNode[];
  edges: MigrationEdge[];
  /** Optimistic-concurrency revision, bumped on every graph edit. */
  revision: number;
}

export interface PathInfo {
  edgeIds: string[];
  nodeIds: string[];
  hops: number;
  totalCost: number;
  /** Path contains at least one edge going back to an older revision. */
  hasRollback: boolean;
  /** All edges exist, validate against node schemas and chain together. */
  valid: boolean;
  issues: EdgeIssue[];
}

export interface CycleInfo {
  nodeIds: string[];
  edgeIds: string[];
}

export interface Sample {
  id: string;
  name: string;
  doc: unknown;
}

export type PathRunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type ExperimentStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface StepResult {
  edgeId: string;
  fnRevision: number;
  input: unknown;
  output: unknown;
  status: 'ok' | 'failed' | 'skipped';
  stage?: 'condition' | 'function';
  error?: string;
}

export interface PathRun {
  pathIndex: number;
  edgeIds: string[];
  hops: number;
  totalCost: number;
  hasRollback: boolean;
  status: PathRunStatus;
  steps: StepResult[];
  failedEdgeId?: string;
  result?: unknown;
  error?: string;
}

export interface Experiment {
  id: string;
  graphRevision: number;
  sampleId: string | null;
  sample: unknown;
  status: ExperimentStatus;
  createdAt: number;
  finishedAt?: number;
  runs: PathRun[];
}
