import type {FieldDef, FieldType, SchemaDef} from './types';

function typeOf(value: unknown): FieldType | 'null' | 'object' | 'undefined' {
  if (value === null) return 'null';
  if (Array.isArray(value) || typeof value === 'object') return 'object';
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') return t;
  return 'undefined';
}

/** Every required declared field is present with a compatible type. Extra fields are allowed. */
export function schemaSatisfies(actual: SchemaDef, required: SchemaDef): boolean {
  const byName = new Map(actual.fields.map(field => [field.name, field]));
  return required.fields.every(field => {
    const found = byName.get(field.name);
    if (!found) return !(field.required ?? true);
    return found.type === field.type;
  });
}

export function validateDoc(doc: unknown, schema: SchemaDef): string | null {
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    return 'document must be a JSON object';
  }
  const record = doc as Record<string, unknown>;
  for (const field of schema.fields) {
    const present = Object.prototype.hasOwnProperty.call(record, field.name);
    if (!present) {
      if (field.required ?? true) return `missing required field "${field.name}"`;
      continue;
    }
    const actual = typeOf(record[field.name]);
    if (actual !== field.type) return `field "${field.name}" expected ${field.type}, got ${actual}`;
  }
  return null;
}

export function fieldDefsEqual(a: FieldDef[], b: FieldDef[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((field, index) => {
    const other = b[index];
    return (
      field.name === other.name &&
      field.type === other.type &&
      (field.required ?? true) === (other.required ?? true)
    );
  });
}

export function schemaKey(schema: SchemaDef): string {
  return schema.fields.map(f => `${f.name}:${f.type}${f.required === false ? '?' : ''}`).join(',');
}
