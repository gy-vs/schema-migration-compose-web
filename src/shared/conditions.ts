import type {Condition} from './types';

export function describeCondition(condition: Condition): string {
  switch (condition.kind) {
    case 'always':
      return 'always';
    case 'fieldExists':
      return `field "${condition.field}" exists`;
    case 'fieldEquals':
      return `field "${condition.field}" === ${JSON.stringify(condition.value)}`;
  }
}

export function validateCondition(condition: unknown): condition is Condition {
  if (!condition || typeof condition !== 'object') return false;
  const kind = (condition as {kind?: unknown}).kind;
  if (kind === 'always') return true;
  if (kind === 'fieldExists')
    return typeof (condition as {field?: unknown}).field === 'string' && (condition as {field: string}).field.length > 0;
  if (kind === 'fieldEquals') {
    const c = condition as {field?: unknown; value?: unknown};
    return (
      typeof c.field === 'string' &&
      c.field.length > 0 &&
      (typeof c.value === 'string' || typeof c.value === 'number' || typeof c.value === 'boolean')
    );
  }
  return false;
}

export function evalCondition(condition: Condition, doc: unknown): {ok: boolean; reason?: string} {
  if (typeof doc !== 'object' || doc === null) return {ok: false, reason: 'document is not an object'};
  const record = doc as Record<string, unknown>;
  switch (condition.kind) {
    case 'always':
      return {ok: true};
    case 'fieldExists':
      return Object.prototype.hasOwnProperty.call(record, condition.field)
        ? {ok: true}
        : {ok: false, reason: `missing field "${condition.field}"`};
    case 'fieldEquals':
      // eslint-disable-next-line eqeqeq
      return record[condition.field] === condition.value
        ? {ok: true}
        : {ok: false, reason: `field "${condition.field}" is not ${JSON.stringify(condition.value)}`};
  }
}
