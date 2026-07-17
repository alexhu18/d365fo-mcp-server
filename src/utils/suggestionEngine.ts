/**
 * Search Suggestion Engine
 * Provides intelligent suggestions for failed or empty search results
 */

import type { XppSymbol } from '../metadata/types.js';
import {
  findFuzzyMatches,
  isProbableTypo,
  generateBroaderSearches,
  generateNarrowerSearches,
  extractRootTerm
} from './fuzzyMatching.js';

export interface SearchSuggestion {
  type: 'typo' | 'broader' | 'narrower' | 'related';
  query: string;
  reason: string;
  confidence: number; // 0-1
}

/**
 * Generate suggestions for a failed search query
 */
export function generateSearchSuggestions(
  query: string,
  allSymbolNames: string[],
  symbolsByTerm: Map<string, XppSymbol[]>,
  maxSuggestions: number = 5
): SearchSuggestion[] {
  const suggestions: SearchSuggestion[] = [];

  const typoSuggestions = generateTypoSuggestions(query, allSymbolNames);
  suggestions.push(...typoSuggestions);

  const broaderSuggestions = generateBroaderSuggestions(query);
  suggestions.push(...broaderSuggestions);

  const narrowerSuggestions = generateNarrowerSuggestions(query);
  suggestions.push(...narrowerSuggestions);

  const relatedSuggestions = generateRelatedSuggestions(query, symbolsByTerm);
  suggestions.push(...relatedSuggestions);

  return suggestions
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, maxSuggestions);
}

/**
 * Generate typo correction suggestions
 */
function generateTypoSuggestions(
  query: string,
  allSymbolNames: string[]
): SearchSuggestion[] {
  const suggestions: SearchSuggestion[] = [];
  const matches = findFuzzyMatches(query, allSymbolNames, 0.7, 5);
  
  for (const match of matches) {
    const isTypo = isProbableTypo(query, match.term, match.score);
    
    suggestions.push({
      type: 'typo',
      query: match.term,
      reason: isTypo 
        ? `Did you mean "${match.term}"?`
        : `Similar term: "${match.term}" (${Math.round(match.score * 100)}% match)`,
      confidence: match.score
    });
  }
  
  return suggestions;
}

/**
 * Generate broader search suggestions
 */
function generateBroaderSuggestions(query: string): SearchSuggestion[] {
  const suggestions: SearchSuggestion[] = [];
  const broaderSearches = generateBroaderSearches(query);
  
  for (const broaderQuery of broaderSearches) {
    const isWildcard = broaderQuery.endsWith('*');
    
    suggestions.push({
      type: 'broader',
      query: broaderQuery,
      reason: isWildcard
        ? `Try wildcard search for "${broaderQuery.slice(0, -1)}" prefix`
        : `Try broader search without suffix`,
      confidence: isWildcard ? 0.6 : 0.7
    });
  }
  
  return suggestions;
}

/**
 * Generate narrower search suggestions
 */
function generateNarrowerSuggestions(query: string): SearchSuggestion[] {
  const suggestions: SearchSuggestion[] = [];
  const narrowerSearches = generateNarrowerSearches(query);

  // Only suggest the most common suffixes
  const topSuffixes = ['Helper', 'Service', 'Manager'];
  
  for (const narrowerQuery of narrowerSearches) {
    const suffix = narrowerQuery.replace(query, '');
    
    if (topSuffixes.includes(suffix)) {
      suggestions.push({
        type: 'narrower',
        query: narrowerQuery,
        reason: `Try with common suffix "${suffix}"`,
        confidence: 0.65
      });
    }
  }
  
  return suggestions;
}

/**
 * Generate related term suggestions based on usage patterns
 */
function generateRelatedSuggestions(
  query: string,
  symbolsByTerm: Map<string, XppSymbol[]>
): SearchSuggestion[] {
  const suggestions: SearchSuggestion[] = [];
  const rootTerm = extractRootTerm(query);
  const relatedTerms = new Set<string>();

  for (const [term, _symbols] of symbolsByTerm) {
    const termRoot = extractRootTerm(term);

    if (termRoot.toLowerCase().includes(rootTerm.toLowerCase()) ||
        rootTerm.toLowerCase().includes(termRoot.toLowerCase())) {
      if (term.toLowerCase() !== query.toLowerCase()) {
        relatedTerms.add(term);
      }
    }
  }

  for (const term of Array.from(relatedTerms).slice(0, 3)) {
    suggestions.push({
      type: 'related',
      query: term,
      reason: `Related term with similar root`,
      confidence: 0.6
    });
  }
  
  return suggestions;
}

/**
 * Format suggestions for display
 */
export function formatSuggestions(suggestions: SearchSuggestion[]): string {
  if (suggestions.length === 0) return '';
  
  const lines: string[] = [];

  const typoSuggestions = suggestions.filter(s => s.type === 'typo');
  const broaderSuggestions = suggestions.filter(s => s.type === 'broader');
  const narrowerSuggestions = suggestions.filter(s => s.type === 'narrower');
  const relatedSuggestions = suggestions.filter(s => s.type === 'related');
  
  if (typoSuggestions.length > 0) {
    lines.push('\n### 🔍 Did you mean?');
    typoSuggestions.forEach(s => {
      lines.push(`• **"${s.query}"** - ${s.reason}`);
    });
  }
  
  if (broaderSuggestions.length > 0) {
    lines.push('\n### 🔎 Try broader search');
    broaderSuggestions.forEach(s => {
      lines.push(`• **"${s.query}"** - ${s.reason}`);
    });
  }
  
  if (narrowerSuggestions.length > 0) {
    lines.push('\n### 🎯 Try narrower search');
    narrowerSuggestions.forEach(s => {
      lines.push(`• **"${s.query}"** - ${s.reason}`);
    });
  }
  
  if (relatedSuggestions.length > 0) {
    lines.push('\n### 🔗 Related terms');
    relatedSuggestions.forEach(s => {
      lines.push(`• **"${s.query}"** - ${s.reason}`);
    });
  }
  
  return lines.join('\n');
}
