/**
 * Shared NodeSpec fragments reused across top-level form pattern specs.
 */

import type { NodeSpec, Occurrence } from '../../types.js';

/** Standard form-level ActionPane (always the first control under Design) */
export function actionPane(occurrence: Occurrence = 'required'): NodeSpec {
  return {
    id: 'ActionPane',
    controlTypes: ['ActionPane'],
    occurrence,
    nameHint: 'ActionPane',
    extraChildren: 'any',
  };
}

/** Custom filter group (QuickFilter + custom filters) above a grid */
export function filterGroup(occurrence: Occurrence = 'optional'): NodeSpec {
  return {
    id: 'FilterGroup',
    controlTypes: ['Group'],
    occurrence,
    nameHint: 'CustomFilterGroup',
    properties: { Style: 'CustomFilter' },
    requiresSubPattern: true,
    allowedSubPatterns: ['CustomAndQuickFilters', 'CustomFilters'],
    extraChildren: 'any',
  };
}

/** Main tabular grid */
export function mainGrid(occurrence: Occurrence = 'required'): NodeSpec {
  return {
    id: 'Grid',
    controlTypes: ['Grid'],
    occurrence,
    nameHint: 'Grid',
    extraChildren: 'any',
  };
}
