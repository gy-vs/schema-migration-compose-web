import type {MigrationGraph, Sample} from '../shared/types';

const now = new Date(0).toISOString();

/**
 * Revision line: v1 -> v2 -> v3 -> v4
 *
 * Multiple equivalent paths from v1 to v4 with different costs, including a
 * direct conditional edge and a v2->v4 shortcut. Rollback edges v2->v1,
 * v3->v2 and v4->v3 create cycles (allowed in the graph).
 */
export function seedGraph(): MigrationGraph {
  return {
    revision: 1,
    nodes: [
      {
        id: 'v1',
        name: 'v1 · legacy profile',
        order: 1,
        schema: {fields: [{name: 'id', type: 'string'}, {name: 'legacyId', type: 'number', required: false}]},
      },
      {
        id: 'v2',
        name: 'v2 · unified identity',
        order: 2,
        schema: {fields: [{name: 'id', type: 'string'}, {name: 'email', type: 'string'}]},
      },
      {
        id: 'v3',
        name: 'v3 · verified accounts',
        order: 3,
        schema: {
          fields: [
            {name: 'id', type: 'string'},
            {name: 'email', type: 'string'},
            {name: 'verified', type: 'boolean'},
          ],
        },
      },
      {
        id: 'v4',
        name: 'v4 · segmented accounts',
        order: 4,
        schema: {
          fields: [
            {name: 'id', type: 'string'},
            {name: 'email', type: 'string'},
            {name: 'verified', type: 'boolean'},
            {name: 'segment', type: 'string'},
          ],
        },
      },
    ],
    edges: [
      {
        id: 'a',
        from: 'v1',
        to: 'v2',
        cost: 3,
        reversible: true,
        condition: {kind: 'always'},
        inputSchema: {fields: [{name: 'id', type: 'string'}]},
        outputSchema: {fields: [{name: 'id', type: 'string'}, {name: 'email', type: 'string'}]},
        fn: {
          revision: 1,
          updatedAt: now,
          body:
            'doc.email = (doc.legacyId != null ? "user" + doc.legacyId : "user" + doc.id.slice(-4)) + "@example.com";\nreturn doc;',
        },
      },
      {
        id: 'b',
        from: 'v2',
        to: 'v3',
        cost: 2,
        reversible: true,
        condition: {kind: 'always'},
        inputSchema: {fields: [{name: 'id', type: 'string'}, {name: 'email', type: 'string'}]},
        outputSchema: {
          fields: [
            {name: 'id', type: 'string'},
            {name: 'email', type: 'string'},
            {name: 'verified', type: 'boolean'},
          ],
        },
        fn: {revision: 1, updatedAt: now, body: 'doc.verified = true;\nreturn doc;'},
      },
      {
        id: 'c',
        from: 'v3',
        to: 'v4',
        cost: 2,
        reversible: true,
        condition: {kind: 'always'},
        inputSchema: {
          fields: [
            {name: 'id', type: 'string'},
            {name: 'email', type: 'string'},
            {name: 'verified', type: 'boolean'},
          ],
        },
        outputSchema: {
          fields: [
            {name: 'id', type: 'string'},
            {name: 'email', type: 'string'},
            {name: 'verified', type: 'boolean'},
            {name: 'segment', type: 'string'},
          ],
        },
        fn: {revision: 1, updatedAt: now, body: 'doc.segment = doc.verified ? "trusted" : "new";\nreturn doc;'},
      },
      {
        id: 'x',
        from: 'v2',
        to: 'v4',
        cost: 6,
        reversible: false,
        condition: {kind: 'always'},
        inputSchema: {fields: [{name: 'id', type: 'string'}, {name: 'email', type: 'string'}]},
        outputSchema: {
          fields: [
            {name: 'id', type: 'string'},
            {name: 'email', type: 'string'},
            {name: 'verified', type: 'boolean'},
            {name: 'segment', type: 'string'},
          ],
        },
        fn: {
          revision: 1,
          updatedAt: now,
          body: 'doc.verified = false;\ndoc.segment = "migration";\nreturn doc;',
        },
      },
      {
        id: 'g',
        from: 'v1',
        to: 'v4',
        cost: 8,
        reversible: false,
        condition: {kind: 'fieldExists', field: 'legacyId'},
        inputSchema: {fields: [{name: 'id', type: 'string'}, {name: 'legacyId', type: 'number'}]},
        outputSchema: {
          fields: [
            {name: 'id', type: 'string'},
            {name: 'email', type: 'string'},
            {name: 'verified', type: 'boolean'},
            {name: 'segment', type: 'string'},
          ],
        },
        fn: {
          revision: 1,
          updatedAt: now,
          body:
            'doc.email = "user" + doc.legacyId + "@example.com";\ndoc.verified = true;\ndoc.segment = "legacy";\ndelete doc.legacyId;\nreturn doc;',
        },
      },
      {
        id: 'r12',
        from: 'v2',
        to: 'v1',
        cost: 4,
        reversible: false,
        condition: {kind: 'always'},
        inputSchema: {fields: [{name: 'id', type: 'string'}, {name: 'email', type: 'string'}]},
        outputSchema: {fields: [{name: 'id', type: 'string'}]},
        fn: {revision: 1, updatedAt: now, body: 'delete doc.email;\nreturn doc;'},
      },
      {
        id: 'r23',
        from: 'v3',
        to: 'v2',
        cost: 3,
        reversible: false,
        condition: {kind: 'always'},
        inputSchema: {
          fields: [{name: 'id', type: 'string'}, {name: 'email', type: 'string'}, {name: 'verified', type: 'boolean'}],
        },
        outputSchema: {fields: [{name: 'id', type: 'string'}, {name: 'email', type: 'string'}]},
        fn: {revision: 1, updatedAt: now, body: 'delete doc.verified;\nreturn doc;'},
      },
      {
        id: 'r34',
        from: 'v4',
        to: 'v3',
        cost: 3,
        reversible: false,
        condition: {kind: 'always'},
        inputSchema: {
          fields: [
            {name: 'id', type: 'string'},
            {name: 'email', type: 'string'},
            {name: 'verified', type: 'boolean'},
            {name: 'segment', type: 'string'},
          ],
        },
        outputSchema: {
          fields: [
            {name: 'id', type: 'string'},
            {name: 'email', type: 'string'},
            {name: 'verified', type: 'boolean'},
          ],
        },
        fn: {revision: 1, updatedAt: now, body: 'delete doc.segment;\nreturn doc;'},
      },
    ],
  };
}

export function seedSamples(): Sample[] {
  return [
    {
      id: 'modern',
      name: 'modern record (no legacyId)',
      doc: {id: 'ac-0042'},
    },
    {
      id: 'legacy',
      name: 'legacy record with legacyId',
      doc: {id: 'ac-0042', legacyId: 7},
    },
  ];
}
