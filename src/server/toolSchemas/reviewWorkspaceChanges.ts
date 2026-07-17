/**
 * MCP tool definition for `review_workspace_changes` (name/description/inputSchema),
 * extracted verbatim from mcpServer.ts. Serialized payload must not change
 * unintentionally — tests/utils/toolSchemaBudget.test.ts ratchets its size.
 */

export const reviewWorkspaceChangesTool = {
    name: 'review_workspace_changes',
    description: 'Code review of uncommitted X++ changes (git diff HEAD): BP violations, missing labels, CoC patterns. ' +
      'Windows/local mode only. NOT for verifying writes (use verify_d365fo_project + get_object_info instead). ' +
      'If the diff looks truncated, do NOT read .xml/.xpp via built-in tools — proceed with the visible portion or narrow the scope.',
    inputSchema: {
      type: 'object',
      properties: {
        directoryPath: { type: 'string', description: 'Absolute path to the local git repository root (e.g. K:\\\\repos\\\\MySolution)' },
      },
      required: ['directoryPath'],
    },
  };
