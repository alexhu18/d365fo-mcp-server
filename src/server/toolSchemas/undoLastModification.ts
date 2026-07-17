/**
 * MCP tool definition for `undo_last_modification` (name/description/inputSchema),
 * extracted verbatim from mcpServer.ts. Serialized payload must not change
 * unintentionally — tests/utils/toolSchemaBudget.test.ts ratchets its size.
 */

export const undoLastModificationTool = {
    name: 'undo_last_modification',
    description: 'Safely roll back incorrectly generated code by restoring a file to its last committed state. If the file is tracked by git, runs git checkout HEAD — this discards ALL uncommitted changes to the file, not just the most recent edit (the "last modification" name is historical). If the file is untracked (newly created), deletes it.\n\nAlso re-syncs the symbol/label index to the restored content — prefer this over a manual git revert or editor undo, which leave the index stale and (for .xml/.xpp) can desync the VS 2022 in-memory model.\n\n⚠️ Local companion tool: available only in write-only/local mode (Windows VM).',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Absolute path to the file to restore to HEAD (or delete, if untracked)' },
      },
      required: ['filePath'],
    },
  };
