/**
 * Deterministic form control expander.
 *
 * Walks the curated form-pattern catalog (the SAME data the validator enforces)
 * and emits the required control skeleton directly, instead of cloning a
 * reference form or hand-writing per-pattern XML. Because generation and
 * validation share one source of truth, the output is structurally
 * pattern-correct by construction — every `required`/`oneOrMore` container the
 * pattern mandates is present, in spec order, with the pattern's expected
 * container properties.
 *
 * Scope & safety:
 *   - Covers patterns that have no hand-written `FormPatternTemplates` entry
 *     (which would otherwise silently degrade to SimpleList).
 *   - `requiresSubPattern` containers are emitted WITHOUT a declared sub-pattern
 *     (an FP006 warning, never an error), keeping the output guaranteed
 *     error-free. Sub-pattern enrichment can be layered on later.
 *   - The caller (generateSmartForm) self-tests the result against
 *     validateFormPatternXml and falls back to the proven templates on error.
 *
 * Indentation is intentionally simple: both the pattern validator (xml2js) and
 * the on-write normalizer (normalizeD365Xml) are whitespace-insensitive, so
 * exact AOT tabbing is applied at write time, not here.
 */

import type { FormPatternSpec, NodeSpec } from '../knowledge/formPatterns/index.js';
import { FormPatternTemplates } from './formPatternTemplates.js';
import type { FieldControlMap } from './fieldControlTypes.js';

export interface ExpandFormOptions {
  formName: string;
  dsName?: string;
  dsTable?: string;
  caption?: string;
  gridFields?: string[];
  fieldTypes?: FieldControlMap;
  linesDsName?: string;
  linesDsTable?: string;
  linesFields?: string[];
  linesFieldTypes?: FieldControlMap;
}

/** Normalized control type → AxForm i:type attribute. */
function iTypeFor(controlType: string): string {
  return `AxForm${controlType}Control`;
}

/** A node is concrete (emittable) when it names a single, specific control type. */
export function isConcrete(spec: NodeSpec): boolean {
  const t = spec.controlTypes[0];
  return spec.controlTypes.length >= 1 && t !== '*' && !!t;
}

/** Required containers only — optional/zeroOrMore slots are left out of the skeleton. */
export function isRequired(spec: NodeSpec): boolean {
  return spec.occurrence === 'required' || spec.occurrence === 'oneOrMore';
}

/**
 * Whether the expander can faithfully build this pattern. It bails when:
 *   - the pattern has no known versions (e.g. the "Custom" escape-hatch pattern),
 *   - any *required* node (at any depth) names no concrete control type (a `*`
 *     wildcard slot — e.g. HubPart's required "Chart"), which the expander cannot
 *     materialise and which would trip FP003.
 *   - sibling slots share a control type (e.g. two `Group`s distinguished only
 *     by Style). Skipping an optional one shifts the validator's type-based
 *     greedy matcher onto the wrong slot, so the result is unreliable.
 * Callers should fall back to a hand-written template / clone for these.
 */
export function canExpandPattern(spec: FormPatternSpec): boolean {
  if (spec.versions.length === 0) return false;

  const requiredNodesConcrete = (nodes: NodeSpec[]): boolean =>
    nodes
      .filter(isRequired)
      .every((n) => isConcrete(n) && requiredNodesConcrete(n.children ?? []));

  // No two sibling specs may share a concrete control type — the validator
  // matches children by type, so duplicates become ambiguous once optionals are
  // dropped. Check every level we emit / the validator descends into.
  const levelUnambiguous = (nodes: NodeSpec[]): boolean => {
    const seen = new Set<string>();
    for (const n of nodes.filter(isConcrete)) {
      const t = n.controlTypes[0];
      if (seen.has(t)) return false;
      seen.add(t);
    }
    return nodes.filter(isRequired).every((n) => levelUnambiguous(n.children ?? []));
  };

  return requiredNodesConcrete(spec.root) && levelUnambiguous(spec.root);
}

/** Serialize a property map into indented <Prop>value</Prop> lines. */
function emitProperties(props: Record<string, string> | undefined, indent: string): string {
  if (!props) return '';
  return Object.entries(props)
    .map(([k, v]) => `${indent}<${k}>${v}</${k}>`)
    .join('\n');
}

/**
 * Public wrapper around {@link emitNode}: render a single pattern NodeSpec (and
 * its required descendants) as AxForm control XML at the given indent depth.
 * Used by the form-repair path to materialise a missing required control.
 * Returns '' for nodes that cannot be concretely emitted.
 */
export function buildControlXml(spec: NodeSpec, opt: ExpandFormOptions, depth: number): string {
  return emitNode(spec, opt, depth);
}

/**
 * Emit one control node and its required descendants. Returns '' for nodes that
 * cannot be concretely emitted (wildcard slots). `gridFields` are rendered as
 * column controls when the node is a Grid bound to the primary datasource.
 */
function emitNode(
  spec: NodeSpec,
  opt: ExpandFormOptions,
  depth: number,
): string {
  if (!isConcrete(spec)) return '';

  const indent = '\t'.repeat(depth);
  const controlType = spec.controlTypes[0];
  const name = spec.nameHint || spec.id;
  const lines: string[] = [];

  lines.push(`${indent}<AxFormControl xmlns="" i:type="${iTypeFor(controlType)}">`);
  lines.push(`${indent}\t<Name>${name}</Name>`);
  lines.push(`${indent}\t<Type>${controlType}</Type>`);
  lines.push(`${indent}\t<FormControlExtension i:nil="true" />`);

  // Required child containers (recursive), plus field columns for a Grid.
  const childSpecs = (spec.children ?? []).filter(isRequired).filter(isConcrete);
  const childXml = childSpecs
    .map((c) => emitNode(c, opt, depth + 2))
    .filter(Boolean)
    .join('\n');

  let gridColumns = '';
  if (controlType === 'Grid' && opt.dsName && (opt.gridFields?.length ?? 0) > 0) {
    gridColumns = opt
      .gridFields!.map((f) =>
        FormPatternTemplates.fieldControl(f, opt.dsName!, '\t'.repeat(depth + 2), 'Grid_', opt.fieldTypes),
      )
      .join('')
      .replace(/\n$/, '');
  }

  const inner = [childXml, gridColumns].filter(Boolean).join('\n');
  if (inner) {
    lines.push(`${indent}\t<Controls>`);
    lines.push(inner);
    lines.push(`${indent}\t</Controls>`);
  } else {
    lines.push(`${indent}\t<Controls />`);
  }

  const props = emitProperties(spec.properties, `${indent}\t`);
  if (props) lines.push(props);

  // Grid needs a DataSource binding to be useful (and FP-correct).
  if (controlType === 'Grid' && opt.dsName) {
    lines.push(`${indent}\t<DataSource>${opt.dsName}</DataSource>`);
  }

  lines.push(`${indent}</AxFormControl>`);
  return lines.join('\n');
}

/** Build the <DataSources> block (primary + optional lines datasource). */
function emitDataSources(opt: ExpandFormOptions): string {
  const ds = (name: string, table: string): string =>
    `\t\t<AxFormDataSource xmlns="">\n` +
    `\t\t\t<Name>${name}</Name>\n` +
    `\t\t\t<Table>${table}</Table>\n` +
    `\t\t\t<Fields />\n` +
    `\t\t\t<ReferencedDataSources />\n` +
    `\t\t\t<InsertIfEmpty>No</InsertIfEmpty>\n` +
    `\t\t\t<DataSourceLinks />\n` +
    `\t\t\t<DerivedDataSources />\n` +
    `\t\t</AxFormDataSource>`;

  const blocks: string[] = [];
  if (opt.dsName && opt.dsTable) blocks.push(ds(opt.dsName, opt.dsTable));
  if (opt.linesDsName && opt.linesDsTable) blocks.push(ds(opt.linesDsName, opt.linesDsTable));
  if (blocks.length === 0) return `\t<DataSources />`;
  return `\t<DataSources>\n${blocks.join('\n')}\n\t</DataSources>`;
}

/**
 * Expand a form pattern spec into complete AxForm XML, deterministically and
 * straight from the catalog. Used for patterns that have no dedicated
 * hand-written template.
 */
export function expandPatternToXml(spec: FormPatternSpec, opt: ExpandFormOptions): string {
  const version = spec.versions[0] ?? '1.0';
  const style = spec.designProperties?.Style ?? spec.xmlName;
  const caption = opt.caption ? `\t\t<Caption xmlns="">${opt.caption}</Caption>\n` : '';
  const titleDs = opt.dsName ? `\t\t<TitleDataSource xmlns="">${opt.dsName}</TitleDataSource>\n` : '';
  const designDs = opt.dsName ? `\t\t<DataSource xmlns="">${opt.dsName}</DataSource>\n` : '';

  const controls = spec.root
    .filter(isRequired)
    .filter(isConcrete)
    .map((node) => emitNode(node, opt, 3))
    .filter(Boolean)
    .join('\n');

  const controlsBlock = controls
    ? `\t\t<Controls xmlns="">\n${controls}\n\t\t</Controls>`
    : `\t\t<Controls xmlns="" />`;

  return (
    `<?xml version="1.0" encoding="utf-8"?>\n` +
    `<AxForm xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V6">\n` +
    `\t<Name>${opt.formName}</Name>\n` +
    `\t<SourceCode>\n` +
    `\t\t<Methods xmlns="">\n` +
    `\t\t\t<Method>\n` +
    `\t\t\t\t<Name>classDeclaration</Name>\n` +
    `\t\t\t\t<Source><![CDATA[\n` +
    `[Form]\n` +
    `public class ${opt.formName} extends FormRun\n` +
    `{\n` +
    `}\n\n` +
    `]]></Source>\n` +
    `\t\t\t</Method>\n` +
    `\t\t</Methods>\n` +
    `\t\t<DataSources xmlns="" />\n` +
    `\t\t<DataControls xmlns="" />\n` +
    `\t\t<Members xmlns="" />\n` +
    `\t</SourceCode>\n` +
    `${emitDataSources(opt)}\n` +
    `\t<Design>\n` +
    `${caption}${designDs}` +
    `\t\t<Pattern xmlns="">${spec.xmlName}</Pattern>\n` +
    `\t\t<PatternVersion xmlns="">${version}</PatternVersion>\n` +
    `\t\t<Style xmlns="">${style}</Style>\n` +
    `${titleDs}` +
    `${controlsBlock}\n` +
    `\t</Design>\n` +
    `\t<Parts />\n` +
    `</AxForm>\n`
  );
}
