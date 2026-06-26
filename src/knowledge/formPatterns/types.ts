/**
 * D365FO Form Pattern Catalog — data model
 *
 * The catalog encodes, as data, what the Visual Studio form-pattern engine
 * enforces: which containers a pattern requires, in which order, what may
 * appear inside them, and which sub-patterns apply to which containers.
 *
 * Sources of truth:
 *   - Microsoft Learn per-pattern guideline docs
 *     (https://learn.microsoft.com/en-us/dynamics365/fin-ops-core/dev-itpro/user-interface/form-styles-patterns)
 *   - Reference forms in PackagesLocalDirectory (CustGroup, CustTable, SalesTable, …)
 *   - Mined pattern usage from the symbol index (form_patterns table) cross-checks
 *     the curated entries; exact <Pattern> strings are confirmed by mining.
 *
 * Control types are normalized i:type values: 'AxFormGridControl' → 'Grid'
 * (see normalizeControlType in src/metadata/formPatternMiner.ts). Extension
 * controls resolve to their FormControlExtension name (e.g. 'QuickFilterControl').
 */

export type Occurrence = 'required' | 'optional' | 'oneOrMore' | 'zeroOrMore';

/** Normalized control type, or '*' for any */
export type ControlType = string;

/** What may appear in a container beyond the explicitly spec'd children */
export type ExtraChildrenPolicy = 'none' | 'any' | ControlType[];

export interface NodeSpec {
  /** Stable id for diagnostics, e.g. 'ActionPane', 'FastTabs' */
  id: string;
  /** Allowed normalized control types at this slot ('*' = any container/control) */
  controlTypes: ControlType[];
  occurrence: Occurrence;
  /** Conventional control name — used by generators/diagnostics, never for matching */
  nameHint?: string;
  /** Properties the pattern expects on this node (e.g. Style: 'FastTabs') — mismatches warn */
  properties?: Record<string, string>;
  /** Container must declare a sub-pattern (missing one warns: "unspecified container") */
  requiresSubPattern?: boolean;
  /** Sub-pattern xmlNames valid here; empty/omitted = any known sub-pattern */
  allowedSubPatterns?: string[];
  /** Explicitly spec'd children, in required order */
  children?: NodeSpec[];
  /** Whether the spec'd children must appear in spec order (default true) */
  childrenOrdered?: boolean;
  /** Children allowed beyond the spec'd ones (default 'any' — anti-false-positive posture) */
  extraChildren?: ExtraChildrenPolicy;
}

export interface FormPatternSpec {
  /** Catalog id (PascalCase, unique) */
  id: string;
  /** Exact <Pattern> string serialized in form XML — confirmed by mining */
  xmlName: string;
  /**
   * Alternative <Pattern> spellings that resolve to this spec. Used for
   * entries whose exact serialized name is not yet confirmed by mining —
   * prevents false FP001 (unknown pattern) blocking. Prune after mining.
   */
  xmlAliases?: string[];
  /** Parent pattern id when this entry is a variant (e.g. DialogReadOnly → Dialog) */
  variantOf?: string;
  /** Human-readable name from the Microsoft docs, e.g. 'Details Master w/ Standard Tabs' */
  displayName: string;
  /** Known PatternVersion strings, newest first */
  versions: string[];
  /** One-paragraph purpose */
  purpose: string;
  /** Decision criteria — when this pattern is the right choice */
  whenToUse: string[];
  whenNotToUse?: string[];
  /** Microsoft reference forms that use this pattern (for cloning) */
  referenceForms: string[];
  /** Expected Design-level properties (e.g. Style) — mismatches warn */
  designProperties?: Record<string, string>;
  /** Datasource expectation: none / at least one / header+lines (≥2) */
  requiresDataSource?: 'none' | 'one' | 'headerLines';
  /** Required tree directly under Design, in required order */
  root: NodeSpec[];
  /** Children allowed directly under Design beyond `root` (default 'none' for strict patterns) */
  extraRootChildren?: ExtraChildrenPolicy;
  /** FormRun/datasource lifecycle guidance for this pattern */
  lifecycleGuidance?: string[];
  /** Caveats: legacy status, namespace quirks, mining uncertainty, … */
  notes?: string[];
}

export interface SubPatternSpec {
  /** Catalog id (PascalCase, unique) */
  id: string;
  /** Exact <Pattern> string on the container control */
  xmlName: string;
  /** Alternative spellings (see FormPatternSpec.xmlAliases) */
  xmlAliases?: string[];
  displayName: string;
  /** Known PatternVersion strings, newest first */
  versions: string[];
  /** Container control types this sub-pattern can be applied to */
  appliesToControlTypes: ControlType[];
  /** Restrict to specific top-level patterns (e.g. workspace section sub-patterns) */
  parentPatterns?: string[];
  purpose: string;
  /** Reference form (and container) examples, e.g. 'CustTable (CustomFilterGroup)' */
  referenceForms?: string[];
  /** Required children of the container, in required order */
  root: NodeSpec[];
  /** Children allowed beyond `root` (default 'any') */
  extraRootChildren?: ExtraChildrenPolicy;
  notes?: string[];
}

export interface FormPatternCatalog {
  patterns: FormPatternSpec[];
  subPatterns: SubPatternSpec[];
}

/**
 * Input controls allowed inside field-oriented sub-patterns (Fields and Field
 * Groups, …). Normalized i:type names; intentionally generous — exotic but
 * legitimate input types should not produce false errors.
 */
export const INPUT_CONTROL_TYPES: ControlType[] = [
  'String',
  'Int',
  'Integer',
  'Int64',
  'Real',
  'Date',
  'UtcDateTime',
  'DateTime',
  'Time',
  'CheckBox',
  'ComboBox',
  'Radio',
  'RadioButton',
  'ReferenceGroup',
  'SegmentedEntry',
  'MultilineText',
  'ListBox',
  'Control', // extension/custom controls (e.g. dimension controls)
];
