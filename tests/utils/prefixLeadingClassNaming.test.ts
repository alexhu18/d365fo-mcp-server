/**
 * EXTENSION_CLASS_NAMING_STYLE="prefix-leading" — writer and validator agreement.
 *
 * The style writes `{Infix}{Base}_Extension`. Its first cut matched the infix
 * case-insensitively and without a word boundary, which produced three defects:
 *   - a "stale trailing infix" strip that cut the base's own last letters
 *     (prefix "Le": SalesTable → LeSalesTab_Extension);
 *   - a camelCase base (whsWorkExecute) whose written name could not be
 *     recognised as prefixed again, so every re-run grew another infix;
 *   - a validator that stripped "Con" off ContactPerson_Extension and reported
 *     base "tactPerson", recommending the unprefixed name back.
 * Writer and validator now share one derivation (prefixLeadingBaseOf), and every
 * case below checks both sides against each other.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { normalizeObjectName } from '../../src/utils/objectNaming.js';
import { applyObjectPrefix, extensionClassBaseOf, registerCustomModel } from '../../src/utils/modelClassifier.js';
import { XmlTemplateGenerator } from '../../src/tools/xml/xmlTemplateGenerator.js';
import { checkObjectNaming } from '../../src/utils/objectNamingRules.js';

const MODEL = 'ContosoExt';

vi.mock('../../src/utils/configManager', () => ({
  getConfigManager: vi.fn(() => ({
    getModelName: () => 'ContosoExt',
    getWriteAnchorModel: () => 'ContosoExt',
    getAutoDetectedModelName: async () => 'ContosoExt',
    getRawAutoDetectedModelName: () => 'ContosoExt',
    getAllDetectedProjects: () => [],
    getToolProjectSwitch: () => null,
  })),
}));

/** An empty symbol index: no conflicts, and base-object probes simply miss. */
const stmt = { all: () => [], get: () => undefined, run: () => {} };
const db: any = { prepare: () => stmt };

const ENV_KEYS = [
  'EXTENSION_PREFIX',
  'EXTENSION_SUFFIX',
  'EXTENSION_NAMING_STYLE',
  'EXTENSION_CLASS_NAMING_STYLE',
  'EXTENSION_PREFIX_SOURCE',
];
let saved: Record<string, string | undefined>;

function configure(prefix: string, classStyle = 'prefix-leading'): void {
  process.env.EXTENSION_PREFIX = prefix;
  process.env.EXTENSION_PREFIX_SOURCE = 'config';
  process.env.EXTENSION_CLASS_NAMING_STYLE = classStyle;
}

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  registerCustomModel(MODEL);
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const write = (name: string, type = 'class-extension') => normalizeObjectName(name, type, MODEL);
const check = (proposedName: string, baseObjectName?: string) =>
  checkObjectNaming(db, { proposedName, objectType: 'class-extension', baseObjectName, modelName: MODEL });
const namingWarnings = (warnings: string[]) =>
  warnings.filter(w => !w.startsWith('Base object'));

describe('prefix-leading: a trailing match that is not a word is not an infix', () => {
  it.each([
    ['Le', 'SalesTable', 'LeSalesTable_Extension'],
    ['Ne', 'SalesLine', 'NeSalesLine_Extension'],
    ['Al', 'LedgerJournal', 'AlLedgerJournal_Extension'],
  ])('prefix %s + %s → %s, from a bare base and from Base_Extension', (prefix, base, expected) => {
    configure(prefix);
    expect(write(base)).toBe(expected);
    expect(write(`${base}_Extension`, 'class')).toBe(expected);
    expect(write(expected)).toBe(expected);
  });

  it.each([
    ['Le', 'SalesTable'],
    ['Ne', 'SalesLine'],
  ])('the validator derives the whole base for prefix %s + %s and accepts what the writer wrote', async (prefix, base) => {
    configure(prefix);
    const written = write(base);
    const r = await check(written);
    expect(r.baseObjectName).toBe(base);
    expect(r.errors).toEqual([]);
    expect(namingWarnings(r.warnings)).toEqual([]);
  });

  it('still converts a name written under the trailing "prefix" style', () => {
    configure('Ctso');
    expect(write('CustTableCtso_Extension', 'class')).toBe('CtsoCustTable_Extension');
    expect(write('CustTableCTSO_Extension', 'class')).toBe('CtsoCustTable_Extension');
  });
});

describe('prefix-leading: a camelCase base stays stable on re-run', () => {
  it('upper-cases the base\'s first letter so the infix ends at a word boundary', () => {
    configure('Ctso');
    const once = write('whsWorkExecute');
    expect(once).toBe('CtsoWhsWorkExecute_Extension');
    expect(write(once)).toBe(once);
    expect(write(write(once))).toBe(once);
  });

  it('the validator accepts the written name and names the base', async () => {
    configure('Ctso');
    const r = await check('CtsoWhsWorkExecute_Extension');
    expect(r.baseObjectName).toBe('WhsWorkExecute');
    expect(r.errors).toEqual([]);
    expect(namingWarnings(r.warnings)).toEqual([]);
  });

  it('…and agrees when the caller passes the camelCase base explicitly', async () => {
    configure('Ctso');
    const r = await check('CtsoWhsWorkExecute_Extension', 'whsWorkExecute');
    expect(r.errors).toEqual([]);
    expect(namingWarnings(r.warnings)).toEqual([]);
  });
});

describe('prefix-leading: the validator strips the infix only where the writer would', () => {
  it('ContactPerson_Extension under "Con" is base ContactPerson, missing its infix', async () => {
    configure('Con');
    const r = await check('ContactPerson_Extension');
    expect(r.baseObjectName).toBe('ContactPerson');
    expect(r.errors).toEqual([]);
    expect(r.warnings.some(w => w.includes('does not lead with the extension infix "Con"'))).toBe(true);
    expect(r.warnings.join('\n')).not.toContain('"tactPerson"');
    // The recommendation is exactly what the writer produces for the same name.
    expect(write('ContactPerson_Extension', 'class')).toBe('ConContactPerson_Extension');
    expect(r.warnings.join('\n')).toContain('Recommended: ConContactPerson_Extension');
  });

  it('an old trailing-style name gets the suggestion the writer would write', async () => {
    configure('Ctso');
    const r = await check('CustTableCtso_Extension');
    expect(r.baseObjectName).toBe('CustTable');
    const written = write('CustTableCtso_Extension', 'class');
    expect(written).toBe('CtsoCustTable_Extension');
    const all = [...r.warnings, ...r.suggestions].join('\n');
    expect(all).toContain(written);
    expect(all).not.toContain('CtsoCustTableCtso_Extension');
  });

  it('a correctly prefix-leading name passes clean', async () => {
    configure('Ctso');
    const r = await check('CtsoCustTable_Extension');
    expect(r.baseObjectName).toBe('CustTable');
    expect(r.errors).toEqual([]);
    expect(namingWarnings(r.warnings)).toEqual([]);
  });
});

describe('a base that itself starts with the infix as a word (ProjTable under "Proj")', () => {
  // Undecidable from the string alone: "ProjTable_Extension" is equally a base
  // ProjTable that needs the infix and a base Table that already has it.

  it('prefix-leading: a bare base states the base, so the infix is added', () => {
    configure('Proj');
    expect(write('ProjTable')).toBe('ProjProjTable_Extension');
    expect(write('ProjProjTable_Extension')).toBe('ProjProjTable_Extension');
  });

  it('prefix-leading: a caller-named ProjTable_Extension stays as given (reads as already prefixed)', () => {
    configure('Proj');
    expect(write('ProjTable_Extension', 'class')).toBe('ProjTable_Extension');
  });

  it('prefix-leading: a caller that knows the base gets the prefix through applyObjectPrefix too', () => {
    configure('Proj');
    expect(applyObjectPrefix('ProjTable_Extension', 'Proj', MODEL, { knownBase: true }))
      .toBe('ProjProjTable_Extension');
  });

  it('prefix-leading: the validator, told the base, recommends what the writer writes', async () => {
    configure('Proj');
    const r = await check('ProjTable_Extension', 'ProjTable');
    expect(r.warnings.some(w => w.includes('does not lead with the extension infix "Proj"'))).toBe(true);
    expect(r.warnings.join('\n')).toContain('Recommended: ProjProjTable_Extension');
    expect(write('ProjTable')).toBe('ProjProjTable_Extension');
  });

  it('"prefix" style: a bare base states the base, so the infix is added', () => {
    configure('Proj', 'prefix');
    expect(write('ProjTable')).toBe('ProjTableProj_Extension');
    expect(write('ProjTableProj_Extension')).toBe('ProjTableProj_Extension');
    expect(applyObjectPrefix('ProjTable_Extension', 'Proj', MODEL, { knownBase: true }))
      .toBe('ProjTableProj_Extension');
  });

  it('"prefix" style: a caller-named ProjTable_Extension stays as given — pinned, ambiguous', () => {
    // The trailing style reads a leading infix at a word boundary as "already
    // prefixed" — that is what keeps a model's own ConDemoRanges_Extension intact.
    configure('Proj', 'prefix');
    expect(write('ProjTable_Extension', 'class')).toBe('ProjTable_Extension');
  });

  it.each([
    ['Tax', 'TaxTrans', 'TaxTransTax_Extension'],
    ['Cr', 'CRMTable', 'CRMTableCr_Extension'],
  ])('"prefix" style: bare %s + %s → %s', (prefix, base, expected) => {
    configure(prefix, 'prefix');
    expect(write(base)).toBe(expected);
    expect(write(expected)).toBe(expected);
  });

  it('"prefix" style: the validator, told the base, recommends what the writer writes', async () => {
    configure('Proj', 'prefix');
    const r = await check('ProjTableProj_Extension');
    expect(r.baseObjectName).toBe('ProjTable');
    expect(r.errors).toEqual([]);
    expect(namingWarnings(r.warnings)).toEqual([]);
    const told = await check('ProjTable_Extension', 'ProjTable');
    expect(told.warnings.join('\n')).toContain('Recommended: ProjTableProj_Extension');
  });
});

/**
 * The same word-boundary rule, applied to the 'prefix' style's trailing infix. A
 * bare case-insensitive endsWith read every base whose last letters spell the
 * infix as already prefixed, so it was never given one.
 */
describe('"prefix" style: a trailing match that is not a word is not an infix', () => {
  it.each([
    ['Le', 'SalesTable', 'SalesTableLe_Extension'],
    ['Ne', 'SalesLine', 'SalesLineNe_Extension'],
    ['Al', 'LedgerJournal', 'LedgerJournalAl_Extension'],
  ])('prefix %s + %s → %s, from a bare base and from Base_Extension', (prefix, base, expected) => {
    configure(prefix, 'prefix');
    expect(write(base)).toBe(expected);
    expect(write(`${base}_Extension`, 'class')).toBe(expected);
    expect(write(expected)).toBe(expected);
  });

  it('a genuinely prefixed name stays as given, in any casing of the infix', () => {
    configure('Ctso', 'prefix');
    expect(write('CustTableCtso_Extension', 'class')).toBe('CustTableCtso_Extension');
    expect(write('CustTableCTSO_Extension', 'class')).toBe('CustTableCTSO_Extension');
  });

  it('an element-style class name keeps its whole base', () => {
    configure('Le', 'prefix');
    expect(write('SalesTableExtension')).toBe('SalesTableLe_Extension');
    expect(write('SalesTableLeExtension')).toBe('SalesTableLe_Extension');
  });

  it.each([
    ['Le', 'SalesTable'],
    ['Ne', 'SalesLine'],
  ])('the validator flags %s + %s_Extension as missing its infix, and agrees with the writer', async (prefix, base) => {
    configure(prefix, 'prefix');
    const r = await check(`${base}_Extension`);
    expect(r.baseObjectName).toBe(base);
    const written = write(`${base}_Extension`, 'class');
    expect(written).toBe(`${base}${prefix}_Extension`);
    expect(r.warnings.join('\n')).toContain(`Recommended: ${written}`);

    const clean = await check(written);
    expect(clean.baseObjectName).toBe(base);
    expect(clean.errors).toEqual([]);
    expect(namingWarnings(clean.warnings)).toEqual([]);
  });
});

describe('"model-name" class style: a base ending in the model name\'s letters keeps them', () => {
  it('SalesTable under model "Able" is not SalesT + "able"', () => {
    configure('Ctso', 'model-name');
    registerCustomModel('Able');
    expect(normalizeObjectName('SalesTable', 'class-extension', 'Able')).toBe('SalesTable_Able_Extension');
    expect(normalizeObjectName('SalesTable_Extension', 'class', 'Able')).toBe('SalesTable_Able_Extension');
    expect(normalizeObjectName('SalesTable_Able_Extension', 'class', 'Able')).toBe('SalesTable_Able_Extension');
  });

  it('a stated base ending in the token AS a word keeps it; a legacy name is still converted', () => {
    configure('Ctso', 'model-name');
    registerCustomModel('Tax');
    // Bare base: the caller said SalesTax is the base.
    expect(normalizeObjectName('SalesTax', 'class-extension', 'Tax')).toBe('SalesTax_Tax_Extension');
    expect(normalizeObjectName('SalesTax_Tax_Extension', 'class', 'Tax')).toBe('SalesTax_Tax_Extension');
    // A legacy CustTableTax_Extension carries the token as its own word — converted.
    expect(normalizeObjectName('CustTableTax_Extension', 'class', 'Tax')).toBe('CustTable_Tax_Extension');
  });

  it('under the prefix class style, Case B only strips the model token as a word', () => {
    configure('Ctso', 'prefix');
    registerCustomModel('Able');
    expect(normalizeObjectName('SalesTable_Extension', 'class', 'Able')).toBe('SalesTableCtso_Extension');
    expect(normalizeObjectName('CustTable_Able_Extension', 'class', 'Able')).toBe('CustTableCtso_Extension');
  });
});

describe('extensionClassBaseOf: the [ExtensionOf] target of a class-extension skeleton', () => {
  it.each([
    ['prefix', 'Ctso', 'CustTableCtso_Extension', 'CustTable'],
    ['prefix', 'Le', 'SalesTableLe_Extension', 'SalesTable'],
    ['prefix', 'Le', 'SalesTable_Extension', 'SalesTable'],
    ['prefix-leading', 'Ctso', 'CtsoCustTable_Extension', 'CustTable'],
    ['prefix-leading', 'Ctso', 'CustTableCtso_Extension', 'CustTable'],
    ['model-name', 'Ctso', 'CustTable_ContosoExt_Extension', 'CustTable'],
  ])('%s style, prefix %s: %s → %s', (style, prefix, name, base) => {
    configure(prefix, style);
    expect(extensionClassBaseOf(name, MODEL)).toBe(base);
  });

  it('XmlTemplateGenerator derives the target through it when no baseClass is given', () => {
    configure('Ctso', 'prefix');
    const xml = XmlTemplateGenerator.generate('class-extension', 'CustTableCtso_Extension', undefined, { modelName: MODEL });
    expect(xml).toContain('[ExtensionOf(classStr(CustTable))]');
    expect(xml).not.toContain('classStr(CustTableCtso_Extension)');
  });

  it('…and an explicit baseClass still wins', () => {
    configure('Ctso', 'prefix');
    const xml = XmlTemplateGenerator.generate('class-extension', 'CustTableCtso_Extension', undefined, { baseClass: 'SalesTable' });
    expect(xml).toContain('[ExtensionOf(classStr(SalesTable))]');
  });
});

describe('the existing styles are untouched', () => {
  it('"prefix" keeps its trailing shape', () => {
    configure('Ctso', 'prefix');
    expect(write('CustTable')).toBe('CustTableCtso_Extension');
    expect(write('whsWorkExecute')).toBe('whsWorkExecuteCtso_Extension');
    expect(write('CustTableCtso_Extension', 'class')).toBe('CustTableCtso_Extension');
  });

  it('"model-name" keeps its shape', () => {
    configure('Ctso', 'model-name');
    expect(write('CustTable')).toBe('CustTable_ContosoExt_Extension');
  });
});
