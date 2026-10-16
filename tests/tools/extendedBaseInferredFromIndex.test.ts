/**
 * validate_object_naming and prepare(mode="create") predict the name create writes
 * for a {Base}{Token}{Feature}_Extension class — without being told the base.
 *
 * create reads the base from [ExtensionOf] and keeps SalesTableMcpCreditHold_Extension
 * as given (#1103). prepare has no source to read it from and does not publish
 * baseObjectName, so both predictors still said SalesTableMcpCreditHoldMcp_Extension:
 * the agent was pointed at a name the writer no longer produces. The index names the
 * base instead — SalesTable is a known table, SalesTableMcpCreditHold is not.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import type { XppServerContext } from '../../src/types/context.js';
import { validateObjectNamingTool } from '../../src/tools/analysis/validateObjectNaming.js';
import { setModelObjectNameSource, clearInferredModelPrefixes } from '../../src/utils/modelPrefixInference.js';
import { inferBaseBeforeToken } from '../../src/utils/modelClassifier.js';
import { inferExtendedBase, normalizeObjectName } from '../../src/utils/objectNaming.js';

const MODEL = 'BenchmarkTestMcp';

vi.mock('../../src/utils/configManager', () => ({
  getConfigManager: vi.fn(() => ({
    getModelName: () => MODEL,
    getWriteAnchorModel: () => MODEL,
    getAutoDetectedModelName: async () => MODEL,
    getRawAutoDetectedModelName: () => MODEL,
    getAllDetectedProjects: () => [],
    getToolProjectSwitch: () => null,
  })),
}));

const KNOWN = new Set(['salestable']);

const buildContext = (): XppServerContext => {
  const hit = (params: unknown[]) => {
    const name = params.find(p => typeof p === 'string' && KNOWN.has(p.replace(/"/g, '').toLowerCase()));
    return name ? { name: 'SalesTable', type: 'table', model: 'ApplicationSuite', extends_class: null, file_path: null } : undefined;
  };
  const stmt = {
    all: vi.fn((...params: unknown[]) => (hit(params) ? [hit(params)] : [])),
    get: vi.fn((...params: unknown[]) => hit(params)),
    run: vi.fn(),
  };
  const db = { prepare: vi.fn(() => stmt) };
  return {
    symbolIndex: { db, getReadDb: () => db, getLastIndexedAt: () => null } as any,
    parser: {} as any,
    cache: {} as any,
    workspaceScanner: {} as any,
    hybridSearch: {} as any,
  };
};

const req = (name: string, args: Record<string, unknown>): CallToolRequest => ({
  method: 'tools/call',
  params: { name, arguments: args },
});

const originalEnv = { ...process.env };

beforeEach(() => {
  clearInferredModelPrefixes();
  setModelObjectNameSource(() => []);
  for (const k of ['EXTENSION_SUFFIX', 'EXTENSION_NAMING_STYLE', 'EXTENSION_CLASS_NAMING_STYLE']) delete process.env[k];
  process.env.EXTENSION_PREFIX = 'Mcp';
  process.env.EXTENSION_PREFIX_SOURCE = 'config';
});

afterEach(() => {
  setModelObjectNameSource(null);
  clearInferredModelPrefixes();
  process.env = { ...originalEnv };
});

describe('{Base}{Token}{Feature}_Extension without a stated base', () => {
  it('validate_object_naming does not predict a second token', async () => {
    const result = await validateObjectNamingTool(
      req('validate_object_naming', { proposedName: 'SalesTableMcpCreditHold_Extension', objectType: 'class-extension', modelName: MODEL }),
      buildContext(),
    );
    const text = String(result.content[0].text);
    expect(text).not.toContain('SalesTableMcpCreditHoldMcp_Extension');
    expect(text).not.toContain('will not use this name as given');
  });

  it('prepare(mode="create") predicts the name create writes', async () => {
    const { prepareCreateTool } = await import('../../src/tools/prepare/prepareCreate.js');
    const result = await prepareCreateTool(
      { params: { arguments: { goal: 'credit hold', objectName: 'SalesTableMcpCreditHold_Extension', objectType: 'class-extension' } } },
      buildContext(),
    );
    const text = String(result.content[0].text);
    expect(text).toContain('SalesTableMcpCreditHold_Extension');
    expect(text).not.toContain('SalesTableMcpCreditHoldMcp_Extension');
  });

  it('prepare still adds the token when the name carries none', async () => {
    const { prepareCreateTool } = await import('../../src/tools/prepare/prepareCreate.js');
    const result = await prepareCreateTool(
      { params: { arguments: { goal: 'credit hold', objectName: 'SalesTableCreditHold_Extension', objectType: 'class-extension' } } },
      buildContext(),
    );
    expect(String(result.content[0].text)).toContain('SalesTableCreditHoldMcp_Extension');
  });
});

describe('inferBaseBeforeToken / inferExtendedBase', () => {
  const known = (n: string) => KNOWN.has(n.toLowerCase());

  it.each([
    ['SalesTableMcpCreditHold', 'SalesTable'],
    ['SalesTable_McpCreditHold', 'SalesTable'],
    ['SalesTableMcp2Hold', 'SalesTable'],
    ['SalesTableMcpxHold', undefined],
    ['CustTableMcpCreditHold', undefined],
    ['McpSalesTable', undefined],
  ])('%s → %s', (stem, expected) => {
    expect(inferBaseBeforeToken(stem, ['Mcp'], known)).toBe(expected);
  });

  it('prefers the longest known base', () => {
    const k = (n: string) => ['sales', 'salesmcptable'].includes(n.toLowerCase());
    expect(inferBaseBeforeToken('SalesMcpTableMcpHold', ['Mcp'], k)).toBe('SalesMcpTable');
  });

  it('only reads _Extension class names', () => {
    expect(inferExtendedBase('SalesTable.McpExtension', MODEL, known)).toBeUndefined();
    expect(inferExtendedBase('SalesTableMcpCreditHold_Extension', MODEL, known)).toBe('SalesTable');
  });
});

/**
 * A base that is itself a known object is not split at a token inside its own name.
 *
 * AgreementAutolinkHelper and AgreementAutolinkHelperSalesLine both ship. Under the
 * token "Sales" the longest-known-base rule read the shorter one as the base, so the
 * bare AgreementAutolinkHelperSalesLine_Extension looked already prefixed: prepare and
 * validate_object_naming predicted it unchanged, while create — reading the real base
 * from [ExtensionOf] — wrote AgreementAutolinkHelperSalesLineSales_Extension, and
 * create without a source wrote a CoC class with no token at all. Ordinary words as
 * tokens (Sales, Invent, Tax, Ledger) misread hundreds of shipped bases this way.
 */
describe('a known base that contains the token as a word', () => {
  const SHIPPED = new Set(['salestable', 'agreementautolinkhelper', 'agreementautolinkhelpersalesline']);
  const shipped = (n: string) => SHIPPED.has(n.toLowerCase());
  const NAME = 'AgreementAutolinkHelperSalesLine_Extension';

  beforeEach(() => {
    process.env.EXTENSION_PREFIX = 'Sales';
    for (const n of ['agreementautolinkhelper', 'agreementautolinkhelpersalesline']) KNOWN.add(n);
  });
  afterEach(() => {
    for (const n of ['agreementautolinkhelper', 'agreementautolinkhelpersalesline']) KNOWN.delete(n);
  });

  it('is not split when the whole stem is known', () => {
    expect(inferBaseBeforeToken('AgreementAutolinkHelperSalesLine', ['Sales'], shipped)).toBeUndefined();
    // A stem that is NOT itself known still finds its base.
    expect(inferBaseBeforeToken('AgreementAutolinkHelperSalesHold', ['Sales'], shipped)).toBe('AgreementAutolinkHelper');
  });

  it('prepare(mode="create") predicts the name create writes from [ExtensionOf]', async () => {
    const written = normalizeObjectName(NAME, 'class-extension', MODEL, undefined, { extendedBase: 'AgreementAutolinkHelperSalesLine' });
    expect(written).toBe('AgreementAutolinkHelperSalesLineSales_Extension');
    // create without a source asks the index — and now gets the same answer.
    expect(normalizeObjectName(NAME, 'class-extension', MODEL, undefined, { extendedBase: inferExtendedBase(NAME, MODEL, shipped) }))
      .toBe(written);

    const { prepareCreateTool } = await import('../../src/tools/prepare/prepareCreate.js');
    const result = await prepareCreateTool(
      { params: { arguments: { goal: 'autolink', objectName: NAME, objectType: 'class-extension' } } },
      buildContext(),
    );
    expect(String(result.content[0].text)).toContain(written);
  });

  it('under naming.prefixSource=none the model token is read the same way', () => {
    process.env.EXTENSION_PREFIX_SOURCE = 'none';
    const written = normalizeObjectName(NAME, 'class-extension', 'Sales', undefined, { extendedBase: 'AgreementAutolinkHelperSalesLine' });
    expect(written).toBe('AgreementAutolinkHelperSalesLine_Sales_Extension');
    expect(normalizeObjectName(NAME, 'class-extension', 'Sales', undefined, { extendedBase: inferExtendedBase(NAME, 'Sales', shipped) }))
      .toBe(written);
  });

  it('validate_object_naming says the write path renames it', async () => {
    const result = await validateObjectNamingTool(
      req('validate_object_naming', { proposedName: NAME, objectType: 'class-extension', modelName: MODEL }),
      buildContext(),
    );
    const text = String(result.content[0].text);
    expect(text).toContain('will not use this name as given');
    expect(text).toContain('AgreementAutolinkHelperSalesLineSales_Extension');
  });
});

/**
 * The validator tries the same tokens as the writer. A model whose extensions state
 * an infix (ContosoSK) that differs from its prefix (ConFinSK) writes
 * SalesTableConFinSKHold_Extension as given — the writer also tries the raw prefix —
 * but the validator tried only the infix and the model token, so it warned that the
 * write path would rename the class to SalesTableConFinSKHoldContosoSK_Extension.
 */
describe('a name that carries the prefix where the learned infix differs', () => {
  const LEARNED = 'ContosoFinanceSK';
  const NAME = 'SalesTableConFinSKHold_Extension';

  beforeEach(() => {
    delete process.env.EXTENSION_PREFIX;
    delete process.env.EXTENSION_PREFIX_SOURCE;
    setModelObjectNameSource(m => (m === LEARNED
      ? [...Array.from({ length: 40 }, (_, i) => `ConFinSKObject${i}`),
        'CustTable.ContosoSKExtension', 'SalesTable.ContosoSKExtension', 'VendTable.ContosoSKExtension']
      : []));
  });

  it('is kept by the writer and not flagged by the validator', async () => {
    const known = (n: string) => KNOWN.has(n.toLowerCase());
    expect(normalizeObjectName(NAME, 'class-extension', LEARNED, undefined, { extendedBase: inferExtendedBase(NAME, LEARNED, known) }))
      .toBe(NAME);

    const result = await validateObjectNamingTool(
      req('validate_object_naming', { proposedName: NAME, objectType: 'class-extension', modelName: LEARNED }),
      buildContext(),
    );
    const text = String(result.content[0].text);
    expect(text).not.toContain('will not use this name as given');
    expect(text).not.toContain('SalesTableConFinSKHoldContosoSK_Extension');
  });
});
