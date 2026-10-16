/**
 * Move a control the file itself defines to another place among its siblings.
 *
 * add-control could only put a control where it was created, and only on a form
 * extension: on a plain AxForm the bridge's AddControl appends to the parent
 * (`parent.Controls.Add`) and previousSibling/positionType never reached it. Once a
 * control existed nothing could move it — add-control again answered "already
 * present — skipped" with a ✅, and modify-property refuses PositionType and
 * PreviousSibling because no control type carries them (in an extension they belong
 * to the <AxFormExtensionControl> envelope, not to the control). An agent that had
 * just added display-method fields to a custom form could not put them next to the
 * field they belong with.
 *
 * Where a control sits is expressed in one of two ways, and this module writes
 * whichever the control already uses:
 *
 *  - ORDER — on an AxForm, and for a control nested under a container the
 *    extension owns, position is the control's place in its parent's <Controls>.
 *    The control's element is cut and spliced back after the sibling (or first, or
 *    last), byte for byte, indentation and all.
 *  - ENVELOPE — a control an extension adds to a BASE-form parent sits in an
 *    <AxFormExtensionControl> whose <PositionType>/<PreviousSibling> place it among
 *    children the extension file does not contain. Those two elements are
 *    rewritten after <Parent>, in the order shipped metadata uses (see
 *    envelopeControlLines in formExtensionControlXml.ts).
 *
 * Only within the same parent: moving to another container changes what the
 * control is part of (a field group, a grid), which is remove-control + add-control.
 *
 * Pure and side-effect-free; the file I/O stays in the caller.
 */

import { type XmlNode, parseNodes, firstChild, textValueOf, isWithin, lineIndentOf } from './xmlNodeTree.js';
import { discardedControlRoots, resolvePosition } from './formExtensionControlXml.js';

export interface PlaceFormControlSpec {
  /** <Name> of the control to move (case-insensitive). */
  controlName: string;
  /** The parent the caller expects; a different current parent is refused, not silently ignored. */
  parentControl?: string;
  /** Sibling to place the control after. Implies AfterItem. */
  previousSibling?: string;
  /** "AfterItem" (with previousSibling), "Begin" or "End". */
  positionType?: string;
}

export type PlaceFormControlResult =
  /** `changed` is false when the control already sat there; `detail` says where it is now. */
  | { kind: 'placed'; xml: string; changed: boolean; detail: string }
  | { kind: 'refused'; message: string }
  /** No live control of that name in this file. */
  | { kind: 'not-found'; present: string[] }
  | { kind: 'unsupported' };

interface Located {
  name: string;
  control: XmlNode;
  /** The <AxFormExtensionControl> around the control, when it is in one. */
  envelope?: XmlNode;
  /** The <Controls> the control (or its envelope) is a direct child of. */
  collection?: XmlNode;
  /** Name of the parent: the owning control, "Design", or the envelope's <Parent>. */
  parentName: string;
  discarded: boolean;
}

const SUPPORTED_ROOTS = new Set(['AxForm', 'AxFormExtension']);
const DESIGN = 'Design';

function locateControls(xml: string, root: XmlNode): Located[] {
  const dead = discardedControlRoots(xml, root);
  const found: Located[] = [];
  const nameOf = (n: XmlNode): string => {
    const nameNode = firstChild(n, 'Name');
    return nameNode ? textValueOf(xml, nameNode) : '';
  };
  const visit = (node: XmlNode, owner: XmlNode | undefined, envelope: XmlNode | undefined, collection: XmlNode | undefined): void => {
    for (const child of node.children) {
      if (child.name === 'AxFormControl' || child.name === 'FormControl') {
        const name = nameOf(child);
        if (name) {
          const inEnvelope = child.name === 'FormControl' && envelope;
          const parentNode = inEnvelope ? firstChild(envelope, 'Parent') : undefined;
          found.push({
            name,
            control: child,
            envelope: inEnvelope ? envelope : undefined,
            collection,
            parentName: parentNode ? textValueOf(xml, parentNode) : owner ? nameOf(owner) : DESIGN,
            discarded: dead.some(d => isWithin(child, d)),
          });
        }
      }
      const isControl = child.name === 'AxFormControl' || child.name === 'FormControl';
      visit(
        child,
        isControl ? child : child.name === 'Design' ? undefined : owner,
        child.name === 'AxFormExtensionControl' ? child : envelope,
        child.name === 'Controls' ? child : collection,
      );
    }
  };
  visit(root, undefined, undefined, undefined);
  return found;
}

/** Whether the file defines a live control of this name — what add-control asks before adding. */
export function formDefinesControl(xml: string, controlName: string): boolean {
  return !!findFormControl(xml, controlName);
}

/**
 * The live control of this name the file defines: its own spelling, its parent, and
 * whether that parent is the one the caller named (`requestedParent`; a design-root
 * name such as "FormDesign" counts as "Design"). Undefined when there is none.
 */
export function findFormControl(
  xml: string,
  controlName: string,
  requestedParent?: string,
): { name: string; parentName: string; inRequestedParent: boolean } | undefined {
  const root = parseNodes(xml);
  if (!root || !SUPPORTED_ROOTS.has(root.name)) return undefined;
  const wanted = controlName.trim().toLowerCase();
  const entry = locateControls(xml, root).find(c => !c.discarded && c.name.toLowerCase() === wanted);
  if (!entry) return undefined;
  const asked = requestedParent?.trim() ?? '';
  const formNameNode = firstChild(root, 'Name');
  const formName = formNameNode ? textValueOf(xml, formNameNode) : '';
  const inRequestedParent = !asked
    || asked.toLowerCase() === entry.parentName.toLowerCase()
    || (entry.parentName === DESIGN && !entry.envelope && isDesignRoot(asked, formName));
  return { name: entry.name, parentName: entry.parentName, inRequestedParent };
}

/** The node's own lines: from the start of its line through the newline that ends it. */
function lineSpan(xml: string, node: XmlNode): [number, number] {
  const lineStart = xml.lastIndexOf('\n', node.start - 1) + 1;
  const from = /^[ \t]*$/.test(xml.slice(lineStart, node.start)) ? lineStart : node.start;
  let to = node.end;
  while (to < xml.length && (xml[to] === ' ' || xml[to] === '\t')) to++;
  if (xml[to] === '\n') to++;
  return [from, to];
}

/**
 * The names the bridge's AddControl reads as "the design itself"
 * (FormAuthoringDefaults.IsDesignRootSentinel) — the same list, or a control the
 * bridge just put under "FormDesign" is refused here as being "in Design, not FormDesign".
 */
const isDesignRoot = (name: string | undefined, formName: string): boolean => {
  const n = (name ?? '').trim().toLowerCase();
  const f = formName.trim().toLowerCase();
  return n === '' || n === 'design' || n === 'formdesign' || n === 'root'
    || (!!f && (n === f || n === `${f}design`));
};

/**
 * Whether a control can be put where add-control asks, checked BEFORE the bridge
 * adds it: the bridge appends and saves, so a position found wrong afterwards
 * leaves the control written at the end. Returns the refusal, or undefined to go
 * ahead — also when the parent is not in the file, which is the bridge's to report.
 */
export function checkNewControlPosition(xml: string, spec: PlaceFormControlSpec): string | undefined {
  const position = resolvePosition({ parentControl: spec.parentControl ?? DESIGN, previousSibling: spec.previousSibling, positionType: spec.positionType });
  if (position.kind === 'invalid') return position.message;
  const after = position.kind === 'placed' ? position.previousSibling : undefined;
  if (!after) return undefined;
  if (after.toLowerCase() === spec.controlName.trim().toLowerCase()) {
    return `previousSibling names "${spec.controlName}" itself; name the control it should follow.`;
  }
  const root = parseNodes(xml);
  if (!root || !SUPPORTED_ROOTS.has(root.name)) return undefined;
  const formNameNode = firstChild(root, 'Name');
  const formName = formNameNode ? textValueOf(xml, formNameNode) : '';
  const live = locateControls(xml, root).filter(c => !c.discarded);
  const parent = resolveParentName(live, spec.parentControl, formName);
  if (!parent) return undefined;
  const children = live.filter(c => !c.envelope && c.parentName.toLowerCase() === parent.toLowerCase());
  if (children.some(c => c.name.toLowerCase() === after.toLowerCase())) return undefined;
  return `previousSibling "${after}" is not a direct child of "${spec.parentControl || DESIGN}". ` +
    `Its children are: ${children.map(c => c.name).join(', ') || '(none)'}. A control can only follow a sibling ` +
    `in the same container. Nothing was added.`;
}

/** The parent the bridge would pick: a control of that name first, then the design-root names. */
function resolveParentName(live: Located[], asked: string | undefined, formName: string): string | undefined {
  const a = asked?.trim() ?? '';
  const byName = a && live.find(c => c.name.toLowerCase() === a.toLowerCase());
  if (byName) return byName.name;
  return isDesignRoot(a, formName) ? DESIGN : undefined;
}

/**
 * Shipped metadata is CRLF and the writers hand this module LF; either works. The
 * splice works on LF lines, and a CRLF document comes back CRLF, never mixed.
 */
export function placeFormControl(xml: string, spec: PlaceFormControlSpec): PlaceFormControlResult {
  if (!xml.includes('\r\n')) return placeLf(xml, spec);
  const result = placeLf(xml.replace(/\r\n/g, '\n'), spec);
  return result.kind === 'placed'
    ? { ...result, xml: result.changed ? result.xml.replace(/\n/g, '\r\n') : xml }
    : result;
}

function placeLf(xml: string, spec: PlaceFormControlSpec): PlaceFormControlResult {
  const root = parseNodes(xml);
  if (!root || !SUPPORTED_ROOTS.has(root.name)) return { kind: 'unsupported' };
  const formNameNode = firstChild(root, 'Name');
  const formName = formNameNode ? textValueOf(xml, formNameNode) : '';

  const all = locateControls(xml, root);
  const wanted = spec.controlName.trim().toLowerCase();
  const entry = all.find(c => !c.discarded && c.name.toLowerCase() === wanted);
  if (!entry) return { kind: 'not-found', present: all.filter(c => !c.discarded).map(c => c.name) };

  const asked = spec.parentControl?.trim();
  const sameParent = !asked
    || asked.toLowerCase() === entry.parentName.toLowerCase()
    || (entry.parentName === DESIGN && !entry.envelope && resolveParentName(all.filter(c => !c.discarded), asked, formName) === DESIGN);
  if (!sameParent) {
    return {
      kind: 'refused',
      message:
        `"${entry.name}" is in "${entry.parentName}", not "${asked}". Only a move among the same ` +
        `parent's children is supported: moving it into another container changes what it belongs to. ` +
        `Use remove-control, then add-control under "${asked}" with previousSibling/positionType.`,
    };
  }

  const position = resolvePosition({ parentControl: entry.parentName, previousSibling: spec.previousSibling, positionType: spec.positionType });
  if (position.kind === 'invalid') return { kind: 'refused', message: position.message };
  const after = position.kind === 'placed' ? position.previousSibling : undefined;
  if (after && after.toLowerCase() === wanted) {
    return { kind: 'refused', message: `previousSibling names "${entry.name}" itself; name the control it should follow.` };
  }
  const note = position.note ? ` (${position.note})` : '';

  return entry.envelope
    ? placeEnvelope(xml, entry, entry.envelope, position, note)
    : placeByOrder(xml, entry, position, note);
}

/** A control an extension adds to a base-form parent: rewrite the envelope's position pair. */
function placeEnvelope(
  xml: string,
  entry: Located,
  envelope: XmlNode,
  position: ReturnType<typeof resolvePosition>,
  note: string,
): PlaceFormControlResult {
  const parentNode = firstChild(envelope, 'Parent');
  if (!parentNode) {
    return { kind: 'refused', message: `The envelope of "${entry.name}" has no <Parent>; it cannot be positioned. Re-create it with remove-control + add-control.` };
  }
  const current = (name: string) => {
    const n = firstChild(envelope, name);
    return n ? textValueOf(xml, n) : undefined;
  };
  const wantType = position.kind === 'placed' ? position.positionType : undefined;
  const wantSibling = position.kind === 'placed' ? position.previousSibling : undefined;
  const where = wantType === 'AfterItem' ? `after "${wantSibling}"` : wantType === 'Begin' ? 'first' : 'last';
  if (current('PositionType') === wantType && current('PreviousSibling') === wantSibling) {
    return { kind: 'placed', xml, changed: false, detail: `"${entry.name}" is already ${where} in "${entry.parentName}"${note}` };
  }

  // Cut the existing pair (from the end, so offsets stay valid), then write the new one after <Parent>.
  const old = ['PositionType', 'PreviousSibling']
    .map(n => firstChild(envelope, n))
    .filter((n): n is XmlNode => !!n)
    .map(n => lineSpan(xml, n))
    .sort((a, b) => b[0] - a[0]);
  let updated = xml;
  for (const [from, to] of old) updated = updated.slice(0, from) + updated.slice(to);

  const reparsed = parseNodes(updated);
  const envelopeAgain = reparsed && locateControls(updated, reparsed).find(c => c.control.start === entry.control.start)?.envelope;
  const parentAgain = envelopeAgain && firstChild(envelopeAgain, 'Parent');
  if (!parentAgain) return { kind: 'refused', message: `Internal check failed while positioning "${entry.name}"; the file was left unchanged.` };
  const indent = lineIndentOf(updated, parentAgain.start);
  const lines: string[] = [];
  if (wantType) lines.push(`${indent}<PositionType>${wantType}</PositionType>`);
  if (wantSibling) lines.push(`${indent}<PreviousSibling>${escapeText(wantSibling)}</PreviousSibling>`);
  const insertAt = lineSpan(updated, parentAgain)[1];
  updated = updated.slice(0, insertAt) + lines.map(l => `${l}\n`).join('') + updated.slice(insertAt);
  return verify(updated, entry, `moved "${entry.name}" ${where} in "${entry.parentName}"${note}`);
}

/** A control whose place is its order in the parent's <Controls>: cut it and splice it back. */
function placeByOrder(
  xml: string,
  entry: Located,
  position: ReturnType<typeof resolvePosition>,
  note: string,
): PlaceFormControlResult {
  const collection = entry.collection;
  if (!collection) return { kind: 'refused', message: `"${entry.name}" is not in a <Controls> collection; it cannot be positioned.` };
  const siblings = collection.children.filter(c => c.name === 'AxFormControl');
  const nameOf = (n: XmlNode) => {
    const nameNode = firstChild(n, 'Name');
    return nameNode ? textValueOf(xml, nameNode) : '';
  };
  const self = siblings.indexOf(entry.control);
  // E.g. an <AxFormControl> straight inside an <AxFormExtensionControl> (the envelope
  // holds a <FormControl>): it has no siblings to be ordered among.
  if (self < 0) return { kind: 'refused', message: `"${entry.name}" is not a direct child of a <Controls> collection in this file; it cannot be positioned.` };
  const others = siblings.filter(s => s !== entry.control);

  let anchorAfter: XmlNode | undefined; // insert after this sibling; undefined = first
  let where: string;
  if (position.kind === 'placed' && position.positionType === 'AfterItem') {
    const target = others.find(s => nameOf(s).toLowerCase() === position.previousSibling!.toLowerCase());
    if (!target) {
      return {
        kind: 'refused',
        message:
          `previousSibling "${position.previousSibling}" is not a direct child of "${entry.parentName}". ` +
          `Its children are: ${siblings.map(nameOf).join(', ') || '(none)'}. A control can only follow a sibling ` +
          `in the same container.`,
      };
    }
    anchorAfter = target;
    where = `after "${nameOf(target)}"`;
  } else if (position.kind === 'placed') {
    anchorAfter = undefined;
    where = 'first';
  } else {
    anchorAfter = others[others.length - 1];
    where = 'last';
  }

  // Already there: directly after the anchor, or first when there is none.
  if (anchorAfter ? siblings[self - 1] === anchorAfter : self === 0) {
    return { kind: 'placed', xml, changed: false, detail: `"${entry.name}" is already ${where} in "${entry.parentName}"${note}` };
  }

  const [from, to] = lineSpan(xml, entry.control);
  const block = xml.slice(from, to);
  if (!block.endsWith('\n')) {
    return { kind: 'refused', message: `"${entry.name}" does not sit on lines of its own in this file; it cannot be moved safely. Move it in the form designer.` };
  }
  // Not first already (checked above), so siblings[0] is another control.
  let at = anchorAfter ? lineSpan(xml, anchorAfter)[1] : lineSpan(xml, siblings[0])[0];
  let updated = xml.slice(0, from) + xml.slice(to);
  if (at > from) at -= to - from;
  updated = updated.slice(0, at) + block + updated.slice(at);
  return verify(updated, entry, `moved "${entry.name}" ${where} in "${entry.parentName}"${note}`);
}

/** The result must still parse, hold the control exactly once, and keep the file's placement problems as they were. */
function verify(updated: string, entry: Located, detail: string): PlaceFormControlResult {
  const root = parseNodes(updated);
  const wanted = entry.name.toLowerCase();
  const live = root ? locateControls(updated, root).filter(c => !c.discarded && c.name.toLowerCase() === wanted) : [];
  if (!root || live.length !== 1 || live[0].parentName.toLowerCase() !== entry.parentName.toLowerCase()) {
    return { kind: 'refused', message: `Internal check failed while moving "${entry.name}"; the file was left unchanged. Please report this with the form XML.` };
  }
  return { kind: 'placed', xml: updated, changed: true, detail };
}

const escapeText = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
