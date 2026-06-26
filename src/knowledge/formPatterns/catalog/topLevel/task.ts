/**
 * Task form pattern class (2 LEGACY variants) — migration-only.
 * https://learn.microsoft.com/en-us/dynamics365/fin-ops-core/dev-itpro/user-interface/task-single-form-pattern
 */

import type { FormPatternSpec } from '../../types.js';

export const taskSingle: FormPatternSpec = {
  id: 'TaskSingle',
  xmlName: 'TaskSingle',
  xmlAliases: ['Task', 'SimpleTask'],
  displayName: 'Task Single (legacy)',
  versions: ['1.2', '1.1', '1.0'],
  purpose: 'Legacy AX 2012-style entity form (Overview + General tabs). MIGRATION ONLY — do not use for new forms.',
  whenToUse: ['Migrating an AX 2012 form with Overview/General tabs and a single datasource'],
  whenNotToUse: ['Any NEW form — use Simple List, Simple List & Details, or Details Master instead'],
  referenceForms: ['LedgerJournalTable'],
  requiresDataSource: 'one',
  root: [
    { id: 'ActionPane', controlTypes: ['ActionPane'], occurrence: 'optional', extraChildren: 'any' },
    { id: 'TaskTabs', controlTypes: ['Tab'], occurrence: 'required', extraChildren: 'any' },
  ],
  extraRootChildren: 'any',
};

export const taskDouble: FormPatternSpec = {
  id: 'TaskDouble',
  xmlName: 'TaskParentChild',
  xmlAliases: ['TaskDouble'],
  variantOf: 'TaskSingle',
  displayName: 'Task Double / Parent-Child (legacy)',
  versions: ['1.2', '1.1', '1.0'],
  purpose: 'Legacy AX 2012-style transaction form (two stacked Overview/General sets, header + lines). MIGRATION ONLY.',
  whenToUse: ['Migrating an AX 2012 header+lines form that does not fit Details Transaction'],
  whenNotToUse: ['Any NEW form — use Details Transaction instead'],
  referenceForms: ['HRMAbsenceTableHistory', 'LedgerJournalTransDaily'],
  requiresDataSource: 'headerLines',
  root: [
    { id: 'ActionPane', controlTypes: ['ActionPane'], occurrence: 'optional', extraChildren: 'any' },
    { id: 'UpperTabs', controlTypes: ['Tab'], occurrence: 'required', extraChildren: 'any' },
    { id: 'LowerTabs', controlTypes: ['Tab', 'Group'], occurrence: 'optional', extraChildren: 'any' },
  ],
  extraRootChildren: 'any',
};

export const taskPatterns: FormPatternSpec[] = [taskSingle, taskDouble];
