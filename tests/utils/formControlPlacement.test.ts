/**
 * placeFormControl — moving a control the file defines among its siblings.
 *
 * The case that asked for it: display-method controls added to a custom form
 * landed at the end of their group (the bridge appends), and nothing could move
 * them next to the field they belong with. Every expectation below compares the
 * whole document, so a move that also disturbs a byte elsewhere fails.
 */

import { describe, it, expect } from 'vitest';
import { checkNewControlPosition, formDefinesControl, placeFormControl } from '../../src/utils/formControlPlacement';

const field = (name: string, indent: string) => [
  `${indent}<AxFormControl xmlns="" i:type="AxFormStringControl">`,
  `${indent}\t<Name>${name}</Name>`,
  `${indent}\t<Type>String</Type>`,
  `${indent}\t<FormControlExtension i:nil="true" />`,
  `${indent}</AxFormControl>`,
];

/** A custom form: a group of fields, with two display-method controls appended last. */
const form = (order: string[]) => [
  `<?xml version="1.0" encoding="utf-8"?>`,
  `<AxForm xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V6">`,
  `\t<Name>ConDemoForm</Name>`,
  `\t<Design>`,
  `\t\t<Controls xmlns="">`,
  `\t\t\t<AxFormControl xmlns="" i:type="AxFormGroupControl">`,
  `\t\t\t\t<Name>Header</Name>`,
  `\t\t\t\t<Type>Group</Type>`,
  `\t\t\t\t<FormControlExtension i:nil="true" />`,
  `\t\t\t\t<Controls>`,
  ...order.flatMap(n => field(n, '\t\t\t\t\t')),
  `\t\t\t\t</Controls>`,
  `\t\t\t</AxFormControl>`,
  ...field('Footer', '\t\t\t'),
  `\t\t</Controls>`,
  `\t</Design>`,
  `</AxForm>`,
].join('\n');

const ok = (r: ReturnType<typeof placeFormControl>) => {
  if (r.kind !== 'placed') throw new Error(`expected placed, got ${JSON.stringify(r)}`);
  return r;
};

describe('placeFormControl on a plain form', () => {
  const start = form(['ItemId', 'Name', 'Qty', 'DispPrice', 'DispCost']);

  it('moves a control right after the sibling it belongs with', () => {
    const r = ok(placeFormControl(start, { controlName: 'DispPrice', previousSibling: 'ItemId' }));
    expect(r.changed).toBe(true);
    expect(r.xml).toBe(form(['ItemId', 'DispPrice', 'Name', 'Qty', 'DispCost']));
    expect(r.detail).toContain('after "ItemId" in "Header"');
  });

  it('moves a control forward as well as back', () => {
    const r = ok(placeFormControl(form(['DispPrice', 'ItemId', 'Name']), { controlName: 'DispPrice', previousSibling: 'Name' }));
    expect(r.xml).toBe(form(['ItemId', 'Name', 'DispPrice']));
  });

  it('places first with Begin and last with End', () => {
    expect(ok(placeFormControl(start, { controlName: 'DispCost', positionType: 'Begin' })).xml)
      .toBe(form(['DispCost', 'ItemId', 'Name', 'Qty', 'DispPrice']));
    expect(ok(placeFormControl(start, { controlName: 'ItemId', positionType: 'End' })).xml)
      .toBe(form(['Name', 'Qty', 'DispPrice', 'DispCost', 'ItemId']));
  });

  it('chains: the second display method after the first one', () => {
    const once = ok(placeFormControl(start, { controlName: 'DispPrice', previousSibling: 'Qty' })).xml;
    const twice = ok(placeFormControl(once, { controlName: 'DispCost', previousSibling: 'DispPrice' })).xml;
    expect(twice).toBe(form(['ItemId', 'Name', 'Qty', 'DispPrice', 'DispCost']));
  });

  it('writes nothing when the control is already there', () => {
    const r = ok(placeFormControl(start, { controlName: 'DispPrice', previousSibling: 'Qty' }));
    expect(r.changed).toBe(false);
    expect(r.xml).toBe(start);
    expect(ok(placeFormControl(start, { controlName: 'ItemId', positionType: 'Begin' })).changed).toBe(false);
    expect(ok(placeFormControl(start, { controlName: 'DispCost' })).changed).toBe(false);
  });

  it('accepts the parent by name, and Design or the form name for a top-level control', () => {
    expect(placeFormControl(start, { controlName: 'DispPrice', parentControl: 'header', previousSibling: 'ItemId' }).kind).toBe('placed');
    expect(placeFormControl(start, { controlName: 'Footer', parentControl: 'Design', positionType: 'Begin' }).kind).toBe('placed');
    expect(placeFormControl(start, { controlName: 'Footer', parentControl: 'ConDemoForm', positionType: 'Begin' }).kind).toBe('placed');
  });

  it('accepts every design-root name the bridge accepts (FormAuthoringDefaults.IsDesignRootSentinel)', () => {
    for (const parentControl of ['FormDesign', 'root', 'ConDemoFormDesign', '']) {
      expect(placeFormControl(start, { controlName: 'Footer', parentControl, positionType: 'Begin' }).kind, parentControl).toBe('placed');
    }
  });

  it('refuses a move into another parent instead of ignoring it', () => {
    const r = placeFormControl(start, { controlName: 'DispPrice', parentControl: 'Design', previousSibling: 'Header' });
    expect(r.kind).toBe('refused');
    expect(r.kind === 'refused' && r.message).toContain('remove-control');
  });

  it('refuses a sibling from another container, and names the real ones', () => {
    const r = placeFormControl(start, { controlName: 'DispPrice', previousSibling: 'Footer' });
    expect(r.kind).toBe('refused');
    expect(r.kind === 'refused' && r.message).toContain('ItemId, Name, Qty, DispPrice, DispCost');
  });

  it('refuses itself as previousSibling and an unknown positionType', () => {
    expect(placeFormControl(start, { controlName: 'DispPrice', previousSibling: 'dispprice' }).kind).toBe('refused');
    expect(placeFormControl(start, { controlName: 'DispPrice', positionType: 'Middle' }).kind).toBe('refused');
  });

  it('reports a control the file does not define', () => {
    const r = placeFormControl(start, { controlName: 'Nope', previousSibling: 'ItemId' });
    expect(r.kind).toBe('not-found');
    expect(r.kind === 'not-found' && r.present).toContain('DispPrice');
  });

  it('moves a container with everything inside it', () => {
    const r = ok(placeFormControl(start, { controlName: 'Footer', positionType: 'Begin' }));
    const lines = r.xml.split('\n');
    expect(lines.findIndex(l => l.includes('<Name>Footer</Name>'))).toBeLessThan(lines.findIndex(l => l.includes('<Name>Header</Name>')));
    expect(ok(placeFormControl(r.xml, { controlName: 'Footer', positionType: 'End' })).xml).toBe(start);
  });

  it('moves a control in a CRLF file, as shipped metadata is, and keeps it CRLF', () => {
    const crlf = (x: string) => x.replace(/\n/g, '\r\n');
    const r = ok(placeFormControl(crlf(start), { controlName: 'DispPrice', previousSibling: 'ItemId' }));
    expect(r.changed).toBe(true);
    expect(r.xml).toBe(crlf(form(['ItemId', 'DispPrice', 'Name', 'Qty', 'DispCost'])));
    const same = ok(placeFormControl(crlf(start), { controlName: 'DispCost', positionType: 'End' }));
    expect(same.changed).toBe(false);
    expect(same.xml).toBe(crlf(start));
  });

  it('knows which controls the form defines', () => {
    expect(formDefinesControl(start, 'dispcost')).toBe(true);
    expect(formDefinesControl(start, 'ConDemoForm')).toBe(false);
  });
});

describe('checkNewControlPosition — before the bridge appends a new control', () => {
  const start = form(['ItemId', 'Name']);

  it('lets a position that will work through', () => {
    expect(checkNewControlPosition(start, { controlName: 'DispPrice', parentControl: 'Header', previousSibling: 'itemid' })).toBeUndefined();
    expect(checkNewControlPosition(start, { controlName: 'DispPrice', parentControl: 'Header', positionType: 'Begin' })).toBeUndefined();
    expect(checkNewControlPosition(start, { controlName: 'Top', parentControl: 'FormDesign', previousSibling: 'Header' })).toBeUndefined();
  });

  it('refuses an unknown positionType, AfterItem without a sibling, and itself as sibling', () => {
    expect(checkNewControlPosition(start, { controlName: 'DispPrice', parentControl: 'Header', positionType: 'Middle' })).toMatch(/Middle/);
    expect(checkNewControlPosition(start, { controlName: 'DispPrice', parentControl: 'Header', positionType: 'AfterItem' })).toMatch(/needs previousSibling/);
    expect(checkNewControlPosition(start, { controlName: 'DispPrice', parentControl: 'Header', previousSibling: 'DispPrice' })).toMatch(/itself/);
  });

  it('refuses a sibling that is not a direct child of the parent, and names the real ones', () => {
    expect(checkNewControlPosition(start, { controlName: 'DispPrice', parentControl: 'Header', previousSibling: 'Footer' }))
      .toMatch(/Its children are: ItemId, Name\./);
    expect(checkNewControlPosition(start, { controlName: 'Top', parentControl: 'Design', previousSibling: 'ItemId' }))
      .toMatch(/Its children are: Header, Footer\./);
  });

  it('leaves a parent the file does not have to the bridge', () => {
    expect(checkNewControlPosition(start, { controlName: 'DispPrice', parentControl: 'TabGeneral', previousSibling: 'X' })).toBeUndefined();
  });
});

/** An extension: one control on a base-form group (envelope), one group of its own with two children. */
const extension = (position: string[], nested: string[]) => [
  `<?xml version="1.0" encoding="utf-8"?>`,
  `<AxFormExtension xmlns:i="http://www.w3.org/2001/XMLSchema-instance">`,
  `\t<Name>SalesTable.ConDemo</Name>`,
  `\t<Controls>`,
  `\t\t<AxFormExtensionControl xmlns="">`,
  `\t\t\t<Name>FormExtensionControlab12cd34e</Name>`,
  `\t\t\t<FormControl xmlns="" i:type="AxFormStringControl">`,
  `\t\t\t\t<Name>ConDemoDisp</Name>`,
  `\t\t\t\t<Type>String</Type>`,
  `\t\t\t\t<FormControlExtension i:nil="true" />`,
  `\t\t\t</FormControl>`,
  `\t\t\t<Parent>HeaderGroup</Parent>`,
  ...position.map(l => `\t\t\t${l}`),
  `\t\t</AxFormExtensionControl>`,
  `\t\t<AxFormExtensionControl xmlns="">`,
  `\t\t\t<Name>FormExtensionControlff00ee11d</Name>`,
  `\t\t\t<FormControl xmlns="" i:type="AxFormGroupControl">`,
  `\t\t\t\t<Name>ConDemoGroup</Name>`,
  `\t\t\t\t<Type>Group</Type>`,
  `\t\t\t\t<FormControlExtension i:nil="true" />`,
  `\t\t\t\t<Controls>`,
  ...nested.flatMap(n => field(n, '\t\t\t\t\t')),
  `\t\t\t\t</Controls>`,
  `\t\t\t</FormControl>`,
  `\t\t\t<Parent>Tab</Parent>`,
  `\t\t</AxFormExtensionControl>`,
  `\t</Controls>`,
  `</AxFormExtension>`,
].join('\n');

describe('placeFormControl on a form extension', () => {
  it('writes the position pair of a control on a base-form parent', () => {
    const r = ok(placeFormControl(extension([], ['A', 'B']), { controlName: 'ConDemoDisp', previousSibling: 'SalesId' }));
    expect(r.xml).toBe(extension(['<PositionType>AfterItem</PositionType>', '<PreviousSibling>SalesId</PreviousSibling>'], ['A', 'B']));
  });

  it('replaces an existing pair, and End removes it', () => {
    const placed = extension(['<PositionType>AfterItem</PositionType>', '<PreviousSibling>SalesId</PreviousSibling>'], ['A']);
    expect(ok(placeFormControl(placed, { controlName: 'ConDemoDisp', positionType: 'Begin' })).xml)
      .toBe(extension(['<PositionType>Begin</PositionType>'], ['A']));
    expect(ok(placeFormControl(placed, { controlName: 'ConDemoDisp', positionType: 'End' })).xml)
      .toBe(extension([], ['A']));
    expect(ok(placeFormControl(placed, { controlName: 'ConDemoDisp', previousSibling: 'SalesId' })).changed).toBe(false);
  });

  it('writes the position pair in a CRLF extension with CRLF line ends only', () => {
    const crlf = (x: string) => x.replace(/\n/g, '\r\n');
    const r = ok(placeFormControl(crlf(extension([], ['A'])), { controlName: 'ConDemoDisp', previousSibling: 'SalesId' }));
    expect(r.xml).toBe(crlf(extension(['<PositionType>AfterItem</PositionType>', '<PreviousSibling>SalesId</PreviousSibling>'], ['A'])));
    expect(/[^\r]\n/.test(r.xml)).toBe(false);
  });

  it('reorders a control under a group the extension owns', () => {
    const r = ok(placeFormControl(extension([], ['A', 'B', 'C']), { controlName: 'C', previousSibling: 'A' }));
    expect(r.xml).toBe(extension([], ['A', 'C', 'B']));
  });

  it('takes the envelope parent from <Parent>, not from the wrapper', () => {
    const r = placeFormControl(extension([], ['A']), { controlName: 'ConDemoDisp', parentControl: 'OtherGroup', positionType: 'Begin' });
    expect(r.kind).toBe('refused');
    expect(r.kind === 'refused' && r.message).toContain('"HeaderGroup"');
  });

  it('refuses, rather than throws, for a control in a malformed envelope (<AxFormControl> for <FormControl>)', () => {
    const broken = extension([], ['A']).replace(/(<\/?)FormControl\b/g, '$1AxFormControl');
    for (const positionType of ['Begin', 'End']) {
      const r = placeFormControl(broken, { controlName: 'ConDemoDisp', positionType });
      expect(r.kind, positionType).toBe('refused');
      expect(r.kind === 'refused' && r.message).toContain('cannot be positioned');
    }
  });
});
