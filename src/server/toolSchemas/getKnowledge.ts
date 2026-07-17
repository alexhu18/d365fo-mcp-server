/**
 * MCP tool definition for `get_knowledge` (name/description/inputSchema),
 * extracted verbatim from mcpServer.ts. Serialized payload must not change
 * unintentionally — tests/utils/toolSchemaBudget.test.ts ratchets its size.
 */

export const getKnowledgeTool = {
    name: 'get_knowledge',
    description:
      'X++ knowledge lookup. Choose a `kind`:\n' +
      '• knowledge → queryable X++ rulebook: verified patterns, BP rules, AX2012→D365FO migration. Use BEFORE generating code. Topics incl.: select-statement, coc-authoring, bp-rules, sysoperation, event-handlers, workflow, number-sequences, security, sysda, form patterns.\n' +
      '• error → diagnose a D365FO/X++ compiler or runtime error: structured root cause + step-by-step fix + corrected X++ example (TTS mismatch, UpdateConflict, CSUV1, SYS10028 missing next, overlayering, BP errors, …). Call this instead of guessing — X++ error semantics differ from C#/.NET.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['knowledge', 'error'],
          description: 'knowledge = look up an X++ topic/rule; error = diagnose an error message.',
        },
        // kind=knowledge
        topic: {
          type: 'string',
          description:
            '[knowledge] REQUIRED. Topic to query — e.g. "batch job", "ttsbegin", "RunBase vs SysOperation", ' +
            '"set-based operations", "CoC", "data entities", "number sequences", "security", ' +
            '"temp tables", "today() deprecated", "query patterns", "form patterns"',
        },
        format: {
          type: 'string',
          enum: ['concise', 'detailed'],
          default: 'concise',
          description: '[knowledge] concise = quick reference (default), detailed = full explanation with code examples',
        },
        // kind=error
        errorText: {
          type: 'string',
          description: '[error] REQUIRED. Full error message text as displayed in the X++ compiler or event log',
        },
        errorCode: {
          type: 'string',
          description: '[error] Optional error code (e.g. SYS10028, CSUV1, BPUpgradeCodeToday)',
        },
      },
      // kind is optional: inferred from topic (→ knowledge) or errorText (→ error).
      required: [],
    },
  };
