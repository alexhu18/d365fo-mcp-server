/**
 * Workspace-related container sub-patterns (sections inside an Operational
 * Workspace) + Panorama Section form-part patterns.
 * https://learn.microsoft.com/en-us/dynamics365/fin-ops-core/dev-itpro/user-interface/section-tiles-subpattern
 *
 * Workspace sub-pattern xmlNames follow the underscore convention observed in
 * real metadata (e.g. Workspace_SummaryNumbers_UnboundFields). The remaining
 * exact names are to be confirmed by mining — aliases cover the candidates.
 */

import type { SubPatternSpec } from '../../types.js';

function workspaceSection(
  id: string,
  xmlName: string,
  aliases: string[],
  displayName: string,
  purpose: string,
  referenceForms?: string[],
): SubPatternSpec {
  return {
    id,
    xmlName,
    xmlAliases: aliases,
    displayName,
    versions: ['1.0'],
    appliesToControlTypes: ['Group', 'TabPage'],
    parentPatterns: ['Workspace', 'WorkspaceOperational'],
    purpose,
    referenceForms,
    root: [],
    extraRootChildren: 'any',
    notes: ['xmlName to be confirmed by mining.'],
  };
}

export const workspaceSectionSubPatterns: SubPatternSpec[] = [
  workspaceSection(
    'WorkspaceSectionTiles',
    'Workspace_Tiles',
    ['SectionTiles', 'WorkspaceTiles'],
    'Section Tiles',
    'Set of count tiles / charts in a workspace summary section (tiles bound to menu items, charts via Form Part controls).',
    ['SalesOrderProcessingWorkspace'],
  ),
  workspaceSection(
    'WorkspaceSectionRelatedLinks',
    'Workspace_Links',
    ['SectionRelatedLinks', 'WorkspaceLinks', 'Workspace_RelatedLinks'],
    'Section Related Links',
    'Set of hyperlinks (menu item buttons) in a workspace links section.',
    ['SalesOrderProcessingWorkspace'],
  ),
  workspaceSection(
    'WorkspaceSectionTabbedList',
    'Workspace_TabbedList',
    ['SectionTabbedList'],
    'Section Tabbed List',
    'Multiple list variants in one workspace section — only one visible at a time.',
  ),
  workspaceSection(
    'WorkspaceSectionStackedChart',
    'Workspace_StackedChart',
    ['SectionStackedChart'],
    'Section Stacked Chart',
    'Up to two charts stacked in an Operational Workspace section.',
  ),
  workspaceSection(
    'WorkspaceSectionPowerBI',
    'Workspace_PowerBI',
    ['SectionPowerBI'],
    'Section Power BI',
    'Power BI content section in an Operational Workspace.',
  ),
  workspaceSection(
    'WorkspacePageFilterGroup',
    'Workspace_FilterGroup',
    ['WorkspacePageFilterGroup', 'Workspace_PageFilter'],
    'Workspace Page Filter Group',
    'A single page-level filter applied across workspace sections.',
  ),
  workspaceSection(
    'FiltersAndToolbarStacked',
    'FiltersAndToolbar_Stacked',
    ['FiltersAndToolbarStacked'],
    'Filters and Toolbar - Stacked',
    'Form Part Section List: actions BELOW filters.',
  ),
  workspaceSection(
    'FiltersAndToolbarInline',
    'FiltersAndToolbar_Inline',
    ['FiltersAndToolbarInline'],
    'Filters and Toolbar - Inline',
    'Form Part Section List: filters and actions on the SAME line.',
  ),
];
