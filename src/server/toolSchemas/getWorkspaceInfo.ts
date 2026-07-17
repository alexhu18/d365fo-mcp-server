/**
 * MCP tool definition for `get_workspace_info` (name/description/inputSchema),
 * extracted verbatim from mcpServer.ts. Serialized payload must not change
 * unintentionally — tests/utils/toolSchemaBudget.test.ts ratchets its size.
 */

export const getWorkspaceInfoTool = {
    name: 'get_workspace_info',
    description: `ALWAYS call FIRST at session start. Returns model name, package path, framework directory, project path, environment type, and EXTENSION_PREFIX. Flags placeholder model names and missing prefix. Use projectName/projectPath params for solution switching. This is the authoritative source for target model — not search results.`,
    inputSchema: {
      type: 'object',
      properties: {
        projectName: {
          type: 'string',
          description: 'Preferred way to switch projects. Just the model name, e.g. "ContosoEDS" or "ContosoBank". The server resolves the full path from D365FO_SOLUTIONS_PATH automatically. Use this when the user says "switch to <project>" or opens a different solution.',
        },
        projectPath: {
          type: 'string',
          description: 'Absolute path to a .rnrproj file. Fallback when projectName is ambiguous or D365FO_SOLUTIONS_PATH is not configured. Example: "K:\\\\repos\\\\Contoso\\\\MyProject\\\\MyProject.rnrproj"',
        },
        diagnostics: {
          type: 'boolean',
          default: false,
          description: 'Include verbose diagnostic sections (suffix breakdown, stdio session/handshake dump). Use when debugging client-server connectivity.',
        },
      },
      required: [],
    },
  };
