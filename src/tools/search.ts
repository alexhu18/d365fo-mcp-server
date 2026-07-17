/**
 * X++ Symbol Search Tool
 * Search for classes, tables, methods, and fields by name or keyword
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../types/context.js';
import { validateWorkspacePath } from '../workspace/workspaceUtils.js';
import {
  generateRelatedSearches,
  detectCommonPatterns,
  generateContextualTips,
  formatRichContext
} from '../utils/richContext.js';
import {
  generateSearchSuggestions,
  formatSuggestions
} from '../utils/suggestionEngine.js';
import { tryBridgeSearch } from '../bridge/bridgeAdapter.js';

const SearchArgsSchema = z.object({
  query: z.string().describe('Search query (class name, method name, etc.)'),
  type: z.enum([
    'class', 'table', 'form', 'field', 'method', 'enum', 'edt', 'query', 'view', 'report',
    'security-privilege', 'security-duty', 'security-role',
    'menu-item-display', 'menu-item-action', 'menu-item-output',
    'table-extension', 'class-extension', 'form-extension',
    'enum-extension', 'edt-extension', 'data-entity-extension',
    'all',
  ]).optional().default('all').describe('Filter by object type (all=no filter, use specific type to narrow results)'),
  limit: z.number().max(100).optional().default(20).describe('Maximum results to return'),
  workspacePath: z.string().optional().describe('Optional workspace path to search local project files in addition to external metadata'),
  includeWorkspace: z.boolean().optional().default(false).describe('Whether to include workspace files in search results (workspace-aware search)'),
  verbose: z.boolean().optional().default(false).describe('Include related-searches/patterns/tips sections in the output'),
});

export async function searchTool(request: CallToolRequest, context: XppServerContext) {
  try {
    const args = SearchArgsSchema.parse(request.params.arguments);
    const { symbolIndex } = context;
    if (args.includeWorkspace && args.workspacePath) {
      return await performHybridSearch(args, context);
    }

    // Try C# bridge first (IMetadataProvider — live D365FO metadata)
    const bridgeResult = await tryBridgeSearch(context.bridge, args.query, args.type === 'all' ? undefined : args.type, args.limit);
    if (bridgeResult) return bridgeResult;

    // Standard external metadata search
    return await performExternalSearch(args, symbolIndex);
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error searching symbols: ${error instanceof Error ? error.message : 'Unknown error'}`,
        },
      ],
      isError: true,
    };
  }
}

/**
 * Perform hybrid search (external + workspace)
 */
async function performHybridSearch(
  args: z.infer<typeof SearchArgsSchema>,
  context: XppServerContext
) {
  const { hybridSearch } = context;

  if (args.workspacePath) {
    const validation = await validateWorkspacePath(args.workspacePath);
    if (!validation.valid) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ Invalid workspace path: ${validation.error}`,
          },
        ],
        isError: true,
      };
    }
  }

  const results = await hybridSearch.search(args.query, {
    types: args.type === 'all' ? undefined : [args.type as any],
    limit: args.limit,
    workspacePath: args.workspacePath,
    includeWorkspace: true,
  });

  if (results.length === 0) {
    let output = `No X++ symbols found matching "${args.query}" in external metadata or workspace`;

    try {
      const { symbolIndex } = context;
      const allSymbolNames = symbolIndex.getAllSymbolNames(args.query);
      const symbolsByTerm = symbolIndex.getSymbolsByTerm();

      const suggestions = generateSearchSuggestions(
        args.query,
        allSymbolNames,
        symbolsByTerm,
        5 // max suggestions
      );

      if (suggestions.length > 0) {
        output += '\n' + formatSuggestions(suggestions);
      } else {
        // Fall back to basic tips if no suggestions
        const tips = generateContextualTips(args.query, [], args.type);
        if (tips.length > 0) {
          output += '\n\n## 💡 Suggestions\n';
          tips.forEach(tip => {
            const toolHint = tip.tool ? ` → Use \`${tip.tool}()\`` : '';
            output += `\n• ${tip.tip}${toolHint}`;
          });
        }
      }
    } catch (error) {
      // Suggestion generation can fail if the relationship graph isn't built yet
      console.warn('⚠️ Could not generate search suggestions:', error);
      const tips = generateContextualTips(args.query, [], args.type);
      if (tips.length > 0) {
        output += '\n\n## 💡 Suggestions\n';
        tips.forEach(tip => {
          const toolHint = tip.tool ? ` → Use \`${tip.tool}()\`` : '';
          output += `\n• ${tip.tip}${toolHint}`;
        });
      }
    }
    
    return {
      content: [
        {
          type: 'text',
          text: output,
        },
      ],
    };
  }

  // Convert hybrid results to XppSymbol format for rich context
  const symbols = results.map(r => r.symbol).filter(Boolean) as any[];

  // Rich context sections (related searches / patterns / tips) are opt-in:
  // on a successful search they are mostly generic boilerplate that costs the
  // agent hundreds of tokens per call. Empty-result searches keep suggestions
  // (handled above) because there the guidance is the entire value.
  const relatedSearches = args.verbose ? generateRelatedSearches(args.query, symbols, 5) : [];
  const commonPatterns = args.verbose ? detectCommonPatterns(symbols) : [];
  const tips = args.verbose ? generateContextualTips(args.query, symbols, args.type) : [];

  // Format results with source indicators
  const formatted = results
    .map((r) => {
      const source = r.source === 'workspace' ? '🔹 WORKSPACE' : '📦 EXTERNAL';
      if (r.symbol) {
        const parentPrefix = r.symbol.parentName ? `${r.symbol.parentName}.` : '';
        const signature = r.symbol.signature ? ` - ${r.symbol.signature}` : '';
        return `${source} [${r.symbol.type.toUpperCase()}] ${parentPrefix}${r.symbol.name}${signature}`;
      }
      if (r.file) {
        return `${source} [${r.file.type.toUpperCase()}] ${r.file.name} (${r.file.path})`;
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');

  const workspaceCount = results.filter((r) => r.source === 'workspace').length;
  const externalCount = results.filter((r) => r.source === 'external').length;

  let output = `Found ${results.length} matches (${workspaceCount} workspace, ${externalCount} external):\n\n${formatted}`;

  if (relatedSearches.length > 0) {
    output += '\n\n## 🔍 Related Searches\n';
    relatedSearches.forEach(rel => {
      output += `\n• **"${rel.query}"** - ${rel.reason}`;
    });
  }

  if (commonPatterns.length > 0) {
    output += '\n\n## 💡 Common Patterns\n';
    commonPatterns.forEach(pattern => {
      const freq = pattern.frequency ? ` (found ${pattern.frequency}×)` : '';
      output += `\n• ${pattern.pattern}${freq}`;
    });
  }

  if (tips.length > 0) {
    output += '\n\n## 📌 Tips\n';
    tips.forEach(tip => {
      const toolHint = tip.tool ? ` → Use \`${tip.tool}()\`` : '';
      output += `\n• ${tip.tip}${toolHint}`;
    });
  }

  output += `\n\n💡 **Workspace-aware search** includes both your local project files and D365FO external metadata.`;

  return {
    content: [
      {
        type: 'text',
        text: output,
      },
    ],
  };
}

/**
 * Perform standard external metadata search
 */
async function performExternalSearch(
  args: z.infer<typeof SearchArgsSchema>,
  symbolIndex: any,
) {
  try {
    const types = args.type === 'all' ? undefined : [args.type];
    const results: any[] = symbolIndex.searchSymbols(args.query, args.limit, types) || [];

    if (!results || results.length === 0) {
      const allSymbolNames = symbolIndex.getAllSymbolNames(args.query);
      const symbolsByTerm = symbolIndex.getSymbolsByTerm();

      const suggestions = generateSearchSuggestions(
        args.query,
        allSymbolNames,
        symbolsByTerm,
        5 // max suggestions
      );

      let output = `No X++ symbols found matching "${args.query}"`;

      if (suggestions.length > 0) {
        output += '\n' + formatSuggestions(suggestions);
      } else {
        // Fall back to basic tips if no suggestions
        const tips = generateContextualTips(args.query, [], args.type);
        if (tips.length > 0) {
          output += '\n\n## 💡 Suggestions\n';
          tips.forEach(tip => {
            const toolHint = tip.tool ? ` → Use \`${tip.tool}()\`` : '';
            output += `\n• ${tip.tip}${toolHint}`;
          });
        }
      }
      
      return {
        content: [
          {
            type: 'text',
            text: output,
          },
        ],
      };
    }

    // Rich context sections are opt-in via `verbose` — on a successful search
    // they are mostly generic boilerplate costing hundreds of tokens per call.
    const relatedSearches = args.verbose ? generateRelatedSearches(args.query, results, 5) : [];
    const commonPatterns = args.verbose ? detectCommonPatterns(results) : [];
    const tips = args.verbose ? generateContextualTips(args.query, results, args.type) : [];

    let output = `Found ${results.length} matches:\n`;
    
    output += formatRichContext(args.query, results, {
      relatedSearches,
      commonPatterns,
      tips
    });

    return {
      content: [
        {
          type: 'text',
          text: output,
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error searching symbols: ${error instanceof Error ? error.message : 'Unknown error'}`,
        },
      ],
      isError: true,
    };
  }
}
