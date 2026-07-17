/**
 * MCP tool definition for `get_method` (name/description/inputSchema),
 * extracted verbatim from mcpServer.ts. Serialized payload must not change
 * unintentionally — tests/utils/toolSchemaBudget.test.ts ratchets its size.
 */

export const getMethodTool = {
    name: 'get_method',
    description:
      'Read a method off a class. Choose `include`:\n' +
      '• signature → modifiers/return type/params/attributes only (cheap). REQUIRED before creating CoC extensions — wrong signatures cause compile errors.\n' +
      '• source → full X++ body of the method.\n' +
      '• both (default) → signature followed by source.\n' +
      'Only call for methods confirmed to exist via get_object_info(objectType="class", ...) — never guess method names.',
    inputSchema: {
      type: 'object',
      properties: {
        include: {
          type: 'string',
          enum: ['signature', 'source', 'both'],
          default: 'both',
          description: 'What to return: signature, source, or both (default).',
        },
        className: {
          type: 'string',
          description: 'Name of the class containing the method'
        },
        methodName: {
          type: 'string',
          description: 'Name of the method'
        },
      },
      required: ['className', 'methodName'],
    },
  };
