/**
 * MCP tool definition for `batch_get_info` (name/description/inputSchema),
 * extracted verbatim from mcpServer.ts. Serialized payload must not change
 * unintentionally — tests/utils/toolSchemaBudget.test.ts ratchets its size.
 */
import { BATCH_INFO_TYPES } from '../../tools/objectInfoRegistry.js';

export const batchGetInfoTool = {
    name: 'batch_get_info',
    description: 'Get detailed metadata for multiple D365FO objects in ONE call — the batch counterpart of get_object_info. All lookups run in parallel. Use when you already know 2+ exact object names instead of calling get_object_info one by one.',
    inputSchema: {
      type: 'object',
      properties: {
        objects: {
          type: 'array',
          minItems: 1,
          maxItems: 10,
          description: 'Objects to fetch in parallel (max 10)',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Exact object name (use search first if unsure)' },
              type: {
                type: 'string',
                enum: [...BATCH_INFO_TYPES],
                description: 'Object type — selects the underlying get_*_info tool',
              },
            },
            required: ['name', 'type'],
          },
        },
      },
      required: ['objects'],
    },
  };
