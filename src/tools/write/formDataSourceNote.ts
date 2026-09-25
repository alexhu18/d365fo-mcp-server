/**
 * The note add-data-source leaves when its table was already bound by another
 * data source on the form. The bridge used to SKIP that case instead, on the
 * theory that a second binding is "almost always an accident"; shipped metadata
 * says otherwise, so the write happens and the caller is told what it joined.
 */

import * as fs from 'fs/promises';
import { findBaseFormXml } from '../../utils/baseObjectXml.js';

/**
 * The data sources in a form or form-extension XML that bind `table`, other than
 * `exceptName` (the one just written). `joinSource` is '' for a root data source.
 *
 * Reusing a table is ordinary: of the 8,310 shipped forms with data sources, 753
 * bind one table more than once and 313 do it in two or more UNJOINED roots
 * (DocuHistoryForm: DocuHistoryHeaderDS + DocuHistoryGridDS over DocuHistory).
 * That is why this only feeds a note and never a refusal.
 */
export function dataSourcesBindingTable(
  xml: string,
  table: string,
  exceptName?: string,
): Array<{ name: string; joinSource: string }> {
  const first = (s: string, tag: string) =>
    (new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(s)?.[1] ?? '').trim();
  const found: Array<{ name: string; joinSource: string }> = [];
  for (const block of xml.split('<AxFormDataSource xmlns="">').slice(1)) {
    // Nested collections carry their own <Name>/<JoinSource>; only the data
    // source's own top-level values count.
    let own = block.split('</AxFormDataSource>')[0];
    for (const tag of ['Fields', 'ReferencedDataSources', 'DerivedDataSources', 'Methods', 'Ranges']) {
      own = own.replace(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, 'g'), '');
    }
    const name = first(own, 'Name');
    if (!name || first(own, 'Table').toLowerCase() !== table.trim().toLowerCase()) continue;
    if (exceptName && name.toLowerCase() === exceptName.trim().toLowerCase()) continue;
    found.push({ name, joinSource: first(own, 'JoinSource') });
  }
  return found;
}

/** Note naming the data sources that already bound the table of the one just added. */
export async function describeTableAlreadyBound(
  filePath: string,
  objectType: string,
  objectName: string,
  dsName: string | undefined,
  table: string | undefined,
  symbolIndex: any,
): Promise<string> {
  if (!dsName || !table) return '';
  try {
    const found: Array<{ name: string; joinSource: string; onBase?: boolean }> = [];
    found.push(...dataSourcesBindingTable(await fs.readFile(filePath, 'utf-8'), table, dsName));
    if (objectType === 'form-extension') {
      const baseXml = await findBaseFormXml(objectName.split('.')[0], symbolIndex);
      if (baseXml) {
        found.push(...dataSourcesBindingTable(baseXml, table, dsName).map(d => ({ ...d, onBase: true })));
      }
    }
    if (found.length === 0) return '';
    const list = found
      .map(d => `'${d.name}' (${d.joinSource ? `joined to '${d.joinSource}'` : 'root'}${d.onBase ? ', base form' : ''})`)
      .join(', ');
    return (
      `\n\nℹ️ Table '${table}' was already bound on this form by ${list}. That is legal — shipped ` +
      `forms bind one table in several data sources routinely — so '${dsName}' was written. If you ` +
      `meant to reuse an existing data source rather than add another, undo it with undo_last_modification.`
    );
  } catch {
    // A hint must never be the reason a successful write reports failure.
    return '';
  }
}
