/**
 * Form control repair: auto-fixes a form missing pattern-required top-level
 * controls (FP003). Reads the form's declared pattern, works out which
 * required top-level controls are absent, generates them from the catalog
 * (via the deterministic expander), and splices them into the Design
 * <Controls> collection at the spec-mandated position.
 *
 * The splice is a depth-aware string operation: existing controls are preserved
 * byte-for-byte (children, methods, customisations untouched) — only the
 * missing required controls are inserted. The whole form is never reserialized.
 *
 * Scope: top-level (direct Design child) required controls only. Missing
 * children deeper inside a container, and sub-pattern attachment, are out of
 * scope here (the validator still flags them as warnings/errors for the caller).
 */

import type { FormPatternSpec, NodeSpec } from '../knowledge/formPatterns/index.js';
import { normalizeControlType } from '../metadata/formPatternMiner.js';
import {
  buildControlXml,
  isConcrete,
  isRequired,
  type ExpandFormOptions,
} from './formControlExpander.js';

export interface RepairResult {
  xml: string;
  /** Controls that were generated and inserted. */
  added: Array<{ id: string; type: string }>;
  /** Required controls that could not be auto-added (non-concrete / no Controls block). */
  unfixable: Array<{ id: string; reason: string }>;
  /** True when the form XML was actually changed. */
  changed: boolean;
}

interface DirectChild {
  /** Normalized control type (e.g. 'ActionPane', 'Grid'). */
  type: string;
  /** Byte offset of this child's `<AxFormControl` within the Controls inner content. */
  start: number;
  /** Byte offset just past this child's `</AxFormControl>`. */
  end: number;
}

const OPEN = '<AxFormControl';
const CLOSE = '</AxFormControl>';

/**
 * Locate the Design-level <Controls> collection and return its inner-content
 * span. The Design's own Controls is the first <Controls …> after <Design> —
 * the SourceCode DataSources/DataControls collections live before <Design>, and
 * nested control Controls live deeper. Returns null when the form has no
 * Design or no expandable Controls block (e.g. self-closed and we keep it so).
 */
export function findDesignControls(
  xml: string,
): { innerStart: number; innerEnd: number; selfClosed: boolean; selfCloseAt?: number } | null {
  const designIdx = xml.indexOf('<Design');
  if (designIdx < 0) return null;
  const designEnd = xml.indexOf('</Design>', designIdx);
  const region = designEnd < 0 ? xml.slice(designIdx) : xml.slice(designIdx, designEnd);

  const ctrlRel = region.search(/<Controls\b/);
  if (ctrlRel < 0) return null;
  const ctrlAbs = designIdx + ctrlRel;

  // Find the end of the opening <Controls ...> tag.
  const tagEnd = xml.indexOf('>', ctrlAbs);
  if (tagEnd < 0) return null;
  const openTag = xml.slice(ctrlAbs, tagEnd + 1);

  if (openTag.endsWith('/>')) {
    // Empty <Controls … /> — caller expands it into an open/close pair.
    return { innerStart: ctrlAbs, innerEnd: tagEnd + 1, selfClosed: true, selfCloseAt: ctrlAbs };
  }

  const closeIdx = xml.indexOf('</Controls>', tagEnd);
  if (closeIdx < 0) return null;
  return { innerStart: tagEnd + 1, innerEnd: closeIdx, selfClosed: false };
}

/** Resolve a direct child's normalized control type from its opening tag / <Type>. */
function childType(childXml: string): string {
  const iType = childXml.match(/i:type="(AxForm\w+)"/)?.[1];
  if (iType) {
    const norm = normalizeControlType(iType);
    if (norm) return norm;
  }
  const typeEl = childXml.match(/<Type>([^<]+)<\/Type>/)?.[1];
  return typeEl?.trim() ?? 'Control';
}

/**
 * Scan the Controls inner content for its DIRECT <AxFormControl> children,
 * tracking nesting depth so nested controls are not mistaken for top-level ones.
 */
export function scanDirectChildren(inner: string): DirectChild[] {
  const children: DirectChild[] = [];
  let depth = 0;
  let i = 0;
  let currentStart = -1;

  while (i < inner.length) {
    const nextOpen = inner.indexOf(OPEN, i);
    const nextClose = inner.indexOf(CLOSE, i);
    if (nextOpen < 0 && nextClose < 0) break;

    if (nextClose < 0 || (nextOpen >= 0 && nextOpen < nextClose)) {
      // Ensure it's a real element start ('<AxFormControl' followed by space, >, or />)
      const after = inner[nextOpen + OPEN.length];
      if (after === ' ' || after === '\t' || after === '\n' || after === '>' || after === '/') {
        if (depth === 0) currentStart = nextOpen;
        depth++;
      }
      i = nextOpen + OPEN.length;
    } else {
      depth--;
      if (depth === 0 && currentStart >= 0) {
        const end = nextClose + CLOSE.length;
        children.push({
          type: childType(inner.slice(currentStart, end)),
          start: currentStart,
          end,
        });
        currentStart = -1;
      }
      i = nextClose + CLOSE.length;
    }
  }
  return children;
}

/**
 * Plan which required, concrete root specs are missing from the existing direct
 * children, and the index (in the existing-children array) AFTER which each
 * should be inserted to honour spec order. anchorIndex === -1 means prepend.
 */
export function planInsertions(
  rootSpecs: NodeSpec[],
  existing: DirectChild[],
): { missing: Array<{ spec: NodeSpec; anchorIndex: number }>; unfixable: Array<{ id: string; reason: string }> } {
  const missing: Array<{ spec: NodeSpec; anchorIndex: number }> = [];
  const unfixable: Array<{ id: string; reason: string }> = [];
  const consumed = new Array(existing.length).fill(false);
  let anchorIndex = -1;

  for (const spec of rootSpecs) {
    if (!isRequired(spec)) {
      // Optional spec — advance the anchor past a matching existing control so
      // later required inserts land after it, but never insert it ourselves.
      const j = existing.findIndex((c, idx) => !consumed[idx] && spec.controlTypes.includes(c.type));
      if (j >= 0) {
        consumed[j] = true;
        anchorIndex = j;
      }
      continue;
    }

    if (!isConcrete(spec)) {
      unfixable.push({ id: spec.id, reason: 'pattern slot accepts any control type — cannot auto-generate' });
      continue;
    }

    const j = existing.findIndex((c, idx) => !consumed[idx] && spec.controlTypes.includes(c.type));
    if (j >= 0) {
      consumed[j] = true;
      anchorIndex = j;
    } else {
      missing.push({ spec, anchorIndex });
    }
  }

  return { missing, unfixable };
}

/**
 * Repair a form's missing required top-level controls. Pure — given the form
 * XML, its resolved pattern spec and generation options. Returns the (possibly
 * unchanged) XML plus what was added / could not be fixed.
 */
export function repairFormXml(
  xml: string,
  spec: FormPatternSpec,
  opt: ExpandFormOptions,
): RepairResult {
  const loc = findDesignControls(xml);
  if (!loc) {
    return { xml, added: [], unfixable: [{ id: 'Design', reason: 'no Design <Controls> block found' }], changed: false };
  }

  // Normalize a self-closed <Controls … /> into an open/empty/close pair first.
  let workXml = xml;
  let innerStart: number;
  let innerEnd: number;
  if (loc.selfClosed) {
    const tag = xml.slice(loc.innerStart, loc.innerEnd);
    const opened = tag.replace(/\s*\/>$/, '>') + '\n' + '</Controls>';
    workXml = xml.slice(0, loc.innerStart) + opened + xml.slice(loc.innerEnd);
    innerStart = loc.innerStart + tag.replace(/\s*\/>$/, '>').length + 1;
    innerEnd = innerStart;
  } else {
    innerStart = loc.innerStart;
    innerEnd = loc.innerEnd;
  }

  const inner = workXml.slice(innerStart, innerEnd);
  const existing = scanDirectChildren(inner);
  const { missing, unfixable } = planInsertions(spec.root, existing);

  if (missing.length === 0) {
    return { xml, added: [], unfixable, changed: false };
  }

  // Build the new inner content: walk existing children in order, emitting any
  // generated controls whose anchorIndex points just before them.
  const byAnchor = new Map<number, string[]>();
  const added: Array<{ id: string; type: string }> = [];
  for (const m of missing) {
    const generated = buildControlXml(m.spec, opt, 3);
    if (!generated) {
      unfixable.push({ id: m.spec.id, reason: 'expander produced no XML for this slot' });
      continue;
    }
    if (!byAnchor.has(m.anchorIndex)) byAnchor.set(m.anchorIndex, []);
    byAnchor.get(m.anchorIndex)!.push('\n' + generated);
    added.push({ id: m.spec.id, type: m.spec.controlTypes[0] });
  }

  if (added.length === 0) {
    return { xml, added: [], unfixable, changed: false };
  }

  const pieces: string[] = [];
  // Prepended (anchor -1) controls go first.
  for (const g of byAnchor.get(-1) ?? []) pieces.push(g);
  for (let idx = 0; idx < existing.length; idx++) {
    pieces.push(inner.slice(existing[idx].start, existing[idx].end));
    for (const g of byAnchor.get(idx) ?? []) pieces.push(g);
  }
  // Preserve whatever leading/trailing whitespace framed the original inner.
  const leading = inner.slice(0, existing[0]?.start ?? inner.length);
  const trailing = existing.length > 0 ? inner.slice(existing[existing.length - 1].end) : '';
  const newInner = leading + pieces.join('') + trailing;

  const newXml = workXml.slice(0, innerStart) + newInner + workXml.slice(innerEnd);
  return { xml: newXml, added, unfixable, changed: true };
}
