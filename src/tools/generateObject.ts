/**
 * Generate Tool — unified code generator.
 *
 * Merges the former generate_code and generate_smart tools into one tool
 * discriminated by `mode`:
 *   • pattern  → named X++ skeleton from a pattern enum (text only, no write) — generate_code
 *   • scaffold → pattern-aware whole-object generation table/form/report — generate_smart
 *
 * Param names of the two underlying handlers do not collide, and neither schema
 * is strict, so the request is passed straight through; each handler reads its
 * own fields and ignores the `mode` discriminator.
 *
 * Note: d365fo_file(action="generate") is intentionally NOT merged here — it
 * produces XML for an existing object definition, a different concern.
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import type { XppServerContext } from '../types/context.js';
import { codeGenTool } from './codeGen.js';
import { generateSmartTool } from './generateSmart.js';
import { generateFindMethodsTool } from './generateFindMethods.js';
import { generateRelationXppTool } from './generateRelationXpp.js';
import { generateTableFieldsTool } from './generateTableFields.js';
import { generateTableRelationTool } from './generateTableRelation.js';

function err(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

export async function generateObjectTool(request: CallToolRequest, context: XppServerContext) {
  const a = (request.params.arguments ?? {}) as Record<string, any>;
  const mode = a.mode as string | undefined;

  switch (mode) {
    case 'pattern':
      return codeGenTool(request);
    case 'scaffold':
      return generateSmartTool(request, context);
    case 'find-methods':
      return generateFindMethodsTool(request, context);
    case 'relation-xpp':
      return generateRelationXppTool(request, context);
    case 'fields':
      return generateTableFieldsTool(request, context);
    case 'table-relation':
      return generateTableRelationTool(request, context);
    default:
      return err(`generate_object: unknown mode "${mode}". Use "pattern" (named X++ skeleton, text only), "scaffold" (whole table/form/report), "find-methods" (find/findRecId/exists for a table), "relation-xpp" (table relations → X++ select/query), "fields" (field list → AxTableField XML with auto-EDT), or "table-relation" (EDT-referencing fields → AxTableRelation XML).`);
  }
}

// Tool registration (name, description, inputSchema) lives inline in
// src/server/mcpServer.ts — the single source of truth for tool instructions.
