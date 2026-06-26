/**
 * Panel-style sub-patterns: SidePanel (navigation list of Simple List & Details)
 * and workspace section groups used by the templated Workspace pattern.
 */

import type { SubPatternSpec } from '../../types.js';

export const sidePanel: SubPatternSpec = {
  id: 'SidePanel',
  xmlName: 'SidePanel',
  displayName: 'Side Panel (navigation list)',
  versions: ['1.0'],
  appliesToControlTypes: ['Group'],
  parentPatterns: ['SimpleListDetails'],
  purpose:
    'Left-hand navigation list of a Simple List & Details form: an optional QuickFilter above a ' +
    'list-style grid with 2-3 fields per row.',
  referenceForms: ['PaymTerm (GridContainer)'],
  root: [
    {
      id: 'QuickFilter',
      controlTypes: ['QuickFilterControl'],
      occurrence: 'optional',
      nameHint: 'QuickFilterControl',
    },
    {
      id: 'NavigationList',
      controlTypes: ['Grid'],
      occurrence: 'required',
      properties: { Style: 'List' },
    },
  ],
  extraRootChildren: 'any',
};

export const workspaceSummaryNumbersUnboundFields: SubPatternSpec = {
  id: 'WorkspaceSummaryNumbersUnboundFields',
  xmlName: 'Workspace_SummaryNumbers_UnboundFields',
  displayName: 'Workspace Summary Numbers (Unbound Fields)',
  versions: ['1.0'],
  appliesToControlTypes: ['Group'],
  parentPatterns: ['Workspace'],
  purpose: 'Tile/KPI summary section of an operational workspace (count tiles as unbound fields).',
  referenceForms: ['FmClerkWorkspace'],
  root: [],
  extraRootChildren: 'any',
};

export const panelSubPatterns: SubPatternSpec[] = [
  sidePanel,
  workspaceSummaryNumbersUnboundFields,
];
