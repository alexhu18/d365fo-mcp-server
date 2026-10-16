/**
 * add-control and position, through the file: the bridge appends a control to a
 * plain form and the XML moves it; a control that already exists is moved, not
 * "skipped" with a ✅, and never added twice.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addBaseFormControl, directXmlAddControl } from '../../src/tools/write/directXmlWriters';

const field = (name: string, indent: string) => [
  `${indent}<AxFormControl xmlns="" i:type="AxFormStringControl">`,
  `${indent}\t<Name>${name}</Name>`,
  `${indent}\t<Type>String</Type>`,
  `${indent}\t<FormControlExtension i:nil="true" />`,
  `${indent}</AxFormControl>`,
];

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
  `\t\t</Controls>`,
  `\t</Design>`,
  `</AxForm>`,
  '',
].join('\n');

const order = (xml: string) => [...xml.matchAll(/<Name>(\w+)<\/Name>/g)].map(m => m[1]).filter(n => !['ConDemoForm', 'Header'].includes(n));

let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'add-control-'));
  file = path.join(dir, 'ConDemoForm.xml');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('add-control on a plain form', () => {
  it('moves the control the bridge appended to previousSibling', async () => {
    fs.writeFileSync(file, form(['ItemId', 'Name', 'Qty']));
    // What the bridge's AddControl does: append to the parent and save.
    const bridge = vi.fn(async () => {
      fs.writeFileSync(file, form(['ItemId', 'Name', 'Qty', 'DispPrice']));
      return { success: true, message: "✅ Control 'DispPrice' added to 'Header' via IMetaFormProvider.Update" };
    });
    const r = await addBaseFormControl(file, { controlName: 'DispPrice', parentControl: 'Header', previousSibling: 'ItemId' }, bridge);
    expect(bridge).toHaveBeenCalledOnce();
    expect(r?.success).toBe(true);
    expect(r?.message).toContain('moved "DispPrice" after "ItemId"');
    expect(order(fs.readFileSync(file, 'utf-8'))).toEqual(['ItemId', 'DispPrice', 'Name', 'Qty']);
  });

  it('leaves the bridge result alone when no position is asked', async () => {
    fs.writeFileSync(file, form(['ItemId']));
    const bridge = vi.fn(async () => ({ success: true, message: 'added' }));
    expect(await addBaseFormControl(file, { controlName: 'DispPrice', parentControl: 'Header' }, bridge)).toEqual({ success: true, message: 'added' });
  });

  it('moves a control that already exists instead of adding it again', async () => {
    fs.writeFileSync(file, form(['ItemId', 'Name', 'DispPrice']));
    const bridge = vi.fn(async () => ({ success: true, message: 'added' }));
    const r = await addBaseFormControl(file, { controlName: 'DispPrice', parentControl: 'Header', previousSibling: 'ItemId' }, bridge);
    expect(bridge).not.toHaveBeenCalled();
    expect(r?.success).toBe(true);
    expect(order(fs.readFileSync(file, 'utf-8'))).toEqual(['ItemId', 'DispPrice', 'Name']);
  });

  it('does not add a duplicate when the control exists and no position is asked', async () => {
    fs.writeFileSync(file, form(['ItemId', 'DispPrice']));
    const bridge = vi.fn(async () => ({ success: true, message: 'added' }));
    const r = await addBaseFormControl(file, { controlName: 'DispPrice', parentControl: 'Header' }, bridge);
    expect(bridge).not.toHaveBeenCalled();
    expect(r?.message).toContain('already on the form');
    expect(r?.message).toContain('previousSibling');
  });

  it('refuses a position that cannot work before the bridge writes anything', async () => {
    fs.writeFileSync(file, form(['ItemId']));
    const bridge = vi.fn(async () => ({ success: true, message: 'added' }));
    const r = await addBaseFormControl(file, { controlName: 'DispPrice', parentControl: 'Header', previousSibling: 'Missing' }, bridge);
    expect(bridge).not.toHaveBeenCalled();
    expect(r).toMatchObject({ success: false, viaXmlFallback: true });
    expect(r?.message).toContain('Nothing was added');
    expect(fs.readFileSync(file, 'utf-8')).toBe(form(['ItemId']));
  });

  it('says so when the control was added but could not be positioned', async () => {
    fs.writeFileSync(file, form(['ItemId']));
    // The bridge reports success, but the control is not where the file says it should be.
    const bridge = vi.fn(async () => ({ success: true, message: 'added' }));
    const r = await addBaseFormControl(file, { controlName: 'DispPrice', parentControl: 'Header', previousSibling: 'ItemId' }, bridge);
    expect(r?.success).toBe(true);
    expect(r?.message).toContain('Added at the END');
  });

  it('marks what the bridge took no part in, and what wrote nothing', async () => {
    fs.writeFileSync(file, form(['ItemId', 'DispPrice']));
    const bridge = vi.fn();
    expect(await addBaseFormControl(file, { controlName: 'DispPrice', parentControl: 'Header', positionType: 'Begin' }, bridge))
      .toMatchObject({ success: true, viaXmlFallback: true });
    expect(await addBaseFormControl(file, { controlName: 'DispPrice', parentControl: 'Header', positionType: 'Begin' }, bridge))
      .toMatchObject({ success: true, viaXmlFallback: true, skipped: true });
    expect(await addBaseFormControl(file, { controlName: 'DispPrice', parentControl: 'Header' }, bridge))
      .toMatchObject({ success: true, viaXmlFallback: true, skipped: true });
    expect(bridge).not.toHaveBeenCalled();
  });

  it('keeps CRLF files readable', async () => {
    fs.writeFileSync(file, form(['ItemId', 'Name', 'DispPrice']).replace(/\n/g, '\r\n'));
    const r = await addBaseFormControl(file, { controlName: 'DispPrice', parentControl: 'Header', positionType: 'Begin' }, vi.fn());
    expect(r?.success).toBe(true);
    expect(order(fs.readFileSync(file, 'utf-8'))).toEqual(['DispPrice', 'ItemId', 'Name']);
  });
});

describe('add-control on a form extension', () => {
  const extension = (position: string[]) => [
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
    `\t</Controls>`,
    `</AxFormExtension>`,
    '',
  ].join('\n');

  it('moves an existing control instead of answering "skipped"', async () => {
    fs.writeFileSync(file, extension([]));
    const r = await directXmlAddControl(file, 'ConDemoDisp', 'HeaderGroup', 'String', undefined, undefined, undefined, 'SalesId', undefined);
    expect(r?.success).toBe(true);
    expect(r?.message).toContain('moved "ConDemoDisp" after "SalesId"');
    expect(fs.readFileSync(file, 'utf-8')).toContain('<PreviousSibling>SalesId</PreviousSibling>');
  });

  it('still skips an identical re-add, and says how to move', async () => {
    fs.writeFileSync(file, extension([]));
    const r = await directXmlAddControl(file, 'ConDemoDisp', 'HeaderGroup', 'String');
    expect(r?.skipped).toBe(true);
    expect(r?.message).toContain('skipped');
    expect(r?.message).toContain('previousSibling');
  });
});
