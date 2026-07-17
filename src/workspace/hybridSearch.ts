/**
 * Hybrid Search
 * Combines external D365FO metadata index with local workspace files
 */

import type { XppSymbolIndex } from '../metadata/symbolIndex.js';
import type { WorkspaceScanner, WorkspaceFile } from './workspaceScanner.js';
import type { XppSymbol } from '../metadata/types.js';
import { levenshteinDistance } from '../utils/fuzzyMatching.js';

export interface HybridSearchResult {
  source: 'external' | 'workspace';
  symbol?: XppSymbol;
  file?: WorkspaceFile;
  relevance: number;
}

export class HybridSearch {
  constructor(
    private symbolIndex: XppSymbolIndex,
    private workspaceScanner: WorkspaceScanner
  ) {}

  /**
   * Search in both external metadata and workspace
   */
  async search(
    query: string,
    options: {
      types?: Array<'class' | 'table' | 'form' | 'method' | 'field' | 'enum' | 'query' | 'view'>;
      limit?: number;
      workspacePath?: string;
      includeWorkspace?: boolean;
    } = {}
  ): Promise<HybridSearchResult[]> {
    const results: HybridSearchResult[] = [];

    // External metadata (D365FO PackagesLocalDirectory)
    const externalSymbols = this.symbolIndex.searchSymbols(
      query,
      options.limit || 20,
      options.types
    );

    for (const symbol of externalSymbols) {
      results.push({
        source: 'external',
        symbol,
        relevance: this.calculateRelevance(query, symbol.name),
      });
    }

    // Workspace files, if a workspace path was provided
    if (options.includeWorkspace && options.workspacePath) {
      const workspaceFiles = await this.workspaceScanner.searchInWorkspace(
        options.workspacePath,
        query,
        options.types?.[0] as any // Use first type for workspace filter
      );

      for (const file of workspaceFiles) {
        results.push({
          source: 'workspace',
          file,
          relevance: this.calculateRelevance(query, file.name),
        });
      }
    }

    results.sort((a, b) => b.relevance - a.relevance);

    // Deduplicate by name, preferring workspace over external.
    const seen = new Set<string>();
    const deduplicated: HybridSearchResult[] = [];

    for (const result of results) {
      const name = result.symbol?.name || result.file?.name;
      if (!name) continue;

      if (!seen.has(name)) {
        seen.add(name);
        deduplicated.push(result);
      } else if (result.source === 'workspace') {
        const idx = deduplicated.findIndex(
          (r) => (r.symbol?.name || r.file?.name) === name
        );
        if (idx !== -1) {
          deduplicated[idx] = result;
        }
      }
    }

    return deduplicated.slice(0, options.limit || 20);
  }

  /**
   * Search patterns in workspace code
   */
  async searchPatterns(
    scenario: string,
    workspacePath: string
  ): Promise<{
    externalPatterns: any[];
    workspaceMatches: WorkspaceFile[];
  }> {
    // Get patterns from external metadata
    const externalPatterns = this.symbolIndex.analyzeCodePatterns(scenario);

    // Search workspace for matching files
    const workspaceMatches = await this.workspaceScanner.searchInWorkspace(
      workspacePath,
      scenario
    );

    return {
      externalPatterns,
      workspaceMatches,
    };
  }

  /**
   * Calculate relevance score
   */
  private calculateRelevance(query: string, name: string): number {
    const q = query.toLowerCase();
    const n = name.toLowerCase();

    // Exact match = 100
    if (n === q) return 100;

    // Starts with = 80
    if (n.startsWith(q)) return 80;

    // Contains = 50
    if (n.includes(q)) return 50;

    // Fuzzy match: scale continuously by similarity instead of a flat 30
    const distance = levenshteinDistance(q, n);
    const similarity = 1 - distance / Math.max(q.length, n.length);
    if (similarity >= 0.65) return Math.round(20 + similarity * 30); // 40–50 range

    return 10;
  }
}
