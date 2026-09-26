import {validateDoc} from './schema';
import type {SchemaDef} from './types';

export interface RunOutcome {
  ok: boolean;
  output?: unknown;
  error?: string;
}

/**
 * A migration body is the body of `(doc) => {...}`. It runs in a frozen
 * function scope with no globals, synchronously; each invocation gets a fresh
 * shallow copy of the document so a failed step cannot mutate prior results.
 */
export function compileFunction(body: string): (doc: unknown) => unknown {
  // `Function` gives an isolated function scope. No captured identifiers are
  // passed in; `globalThis` inside the body refers to the real global object,
  // which is acceptable for this local single-user workbench (trusted editor).
  const factory = new Function(
    'doc',
    `"use strict";\nreturn (function migrate(doc) { ${body} \n})(doc);`
  ) as (doc: unknown) => unknown;
  return factory;
}

export function runMigration(body: string, doc: unknown, expectedOutput?: SchemaDef): RunOutcome {
  let fn: (doc: unknown) => unknown;
  try {
    fn = compileFunction(body);
  } catch (error) {
    return {ok: false, error: `compile error: ${(error as Error).message}`};
  }
  let output: unknown;
  try {
    output = fn(structuredClone(doc));
  } catch (error) {
    return {ok: false, error: (error as Error).message};
  }
  if (output === undefined) return {ok: false, error: 'function did not return a document (undefined)'};
  if (expectedOutput) {
    const problem = validateDoc(output, expectedOutput);
    if (problem) return {ok: false, error: `output schema: ${problem}`};
  }
  return {ok: true, output};
}

/** Static check used by validation so broken bodies surface before execution. */
export function checkFunctionBody(body: string): string | null {
  try {
    compileFunction(body);
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}
