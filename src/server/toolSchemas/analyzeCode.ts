/**
 * MCP tool definition for `analyze_code` (name/description/inputSchema),
 * extracted verbatim from mcpServer.ts. Serialized payload must not change
 * unintentionally — tests/utils/toolSchemaBudget.test.ts ratchets its size.
 */

export const analyzeCodeTool = {
    name: 'analyze_code',
    description:
      'Learn from the existing codebase. Choose a `mode`:\n' +
      '• patterns → common classes/methods/dependencies for a scenario (call BEFORE generate_object(mode="pattern")).\n' +
      '• implementations → real implementation examples of a similar method (actual code).\n' +
      '• completeness → missing standard methods on a class (find/exist/validate gaps).\n' +
      '• api-usage → how an API/class is initialized and called in practice.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['patterns', 'implementations', 'completeness', 'api-usage'],
          description: 'Which analysis to run.',
        },
        // mode=patterns
        scenario: { type: 'string', description: '[patterns] REQUIRED. Scenario/functionality to analyze (e.g., "financial dimensions", "inventory transactions").' },
        classPattern: { type: 'string', description: '[patterns] Optional class name pattern to filter results (e.g., "Helper", "Service").' },
        // mode=implementations
        methodName: { type: 'string', description: '[implementations] REQUIRED. Name of the method to implement.' },
        parameters: {
          type: 'array',
          description: '[implementations] Method parameters.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              type: { type: 'string' },
            },
            required: ['name', 'type'],
          },
        },
        returnType: { type: 'string', default: 'void', description: '[implementations] Method return type.' },
        // mode=implementations|completeness
        className: { type: 'string', description: '[implementations|completeness] REQUIRED. Class to analyze / containing the method.' },
        // mode=api-usage
        apiName: { type: 'string', description: '[api-usage] REQUIRED. Name of the API/class to get usage patterns for.' },
        context: { type: 'string', description: '[api-usage] Optional context to filter patterns (e.g., "initialization", "validation").' },
        // shared
        limit: { type: 'number', description: '[patterns] Maximum number of pattern examples to return', default: 5 },
      },
      required: ['mode'],
    },
  };
