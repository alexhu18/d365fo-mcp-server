/**
 * MCP tool definition for `run_bp_check` (name/description/inputSchema),
 * extracted verbatim from mcpServer.ts. Serialized payload must not change
 * unintentionally — tests/utils/toolSchemaBudget.test.ts ratchets its size.
 */

export const runBpCheckTool = {
    name: 'run_bp_check',
    description: 'Run Microsoft Best Practices checker (xppbp.exe) on a D365FO project. Returns BP warnings and errors with rule codes (e.g. BPErrorLabelIsText, BPXmlDocNoDocumentationComments).',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Absolute path to the .rnrproj file to analyze. Auto-detected from .mcp.json if omitted.' },
        targetFilter: { type: 'string', description: 'Optional: filter results to a specific object name (class, table, form, enum, ...).' },
        targetElementType: { type: 'string', description: 'Element type for the filter when using xppbp 10.0.24+ (equals-style CLI). Common values: class, table, form, enum, view, query. Defaults to "class" when targetFilter is set but this is omitted.' },
        modelName: { type: 'string', description: 'Model name to check. Auto-detected from .mcp.json if omitted.' },
        packagePath: { type: 'string', description: 'PackagesLocalDirectory root path. Auto-detected from .mcp.json if omitted.' },
      },
      required: [],
    },
  };
