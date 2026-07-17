/**
 * MCP tool definition for `suggest_edt` (name/description/inputSchema),
 * extracted verbatim from mcpServer.ts. Serialized payload must not change
 * unintentionally — tests/utils/toolSchemaBudget.test.ts ratchets its size.
 */

export const suggestEdtTool = {
    name: 'suggest_edt',
    description: 'Suggest Extended Data Types (EDT) for a field name using fuzzy matching. Returns confidence-ranked suggestions with EDT properties. Use BEFORE creating table fields to reuse existing EDTs.',
    inputSchema: {
      type: 'object',
      properties: {
        fieldName: {
          type: 'string',
          description: 'Field name to suggest EDT for (e.g., "CustomerAccount", "OrderAmount")',
        },
        context: {
          type: 'string',
          description: 'Optional context (e.g., "sales order") to improve suggestions',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of suggestions (default: 5)',
          default: 5,
        },
      },
      required: ['fieldName'],
    },
  };
