/**
 * prepare and validate_object_naming must not disagree about a name.
 *
 * They did. The naming RULES existed only inside the validate_object_naming tool —
 * the module exported nothing but the MCP wrapper — so prepare could not reuse them
 * and grew two hand-rolled validators instead. Live, on the same input:
 *
 *   prepare(mode="create", objectName="CustTable", objectType="table")
 *     -> "Naming looks valid."
 *   validate_object_naming(proposedName="CustTable", objectType="table")
 *     -> "Proposed name does not start with model prefix"
 *
 * and for an extension:
 *
 *   prepare(mode="change", proposedName="CustTable_Ext")
 *     -> "Confirm naming follows your convention"      (no check at all)
 *   validate_object_naming(… "table-extension", base "CustTable")
 *     -> hard ERROR plus the expected name "CustTable.CRExtension"
 *
 * tests/tools/prefixResolutionAgreement.test.ts pins workspace_info to the validator.
 * This one pins prepare to it, which is the pair that had drifted.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import type { XppServerContext } from '../../src/types/context.js';
import { validateObjectNamingTool } from '../../src/tools/analysis/validateObjectNaming.js';
import { prepareCreateTool } from '../../src/tools/prepare/prepareCreate.js';
import { prepareChangeTool } from '../../src/tools/prepare/prepareChange.js';
import { setModelObjectNameSource, clearInferredModelPrefixes } from '../../src/utils/modelPrefixInference.js';
import { normalizeObjectName } from '../../src/utils/objectNaming.js';

const MODEL = 'ContosoRobotics';
const PREFIX = 'CR';
/** The model's own objects all carry the short prefix, so it is the effective one. */
const MODEL_OBJECTS = Array.from({ length: 40 }, (_, i) => 'CRObject' + i);

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

/** Only CustTable resolves, so an unrelated "not indexed" warning cannot mask a naming one. */
const buildContext = (): XppServerContext => {
  const hit = (params: unknown[]) =>
    params.some(p => typeof p === 'string' && p.replace(/"/g, '') === 'CustTable')
      ? { name: 'CustTable', type: 'table', model: 'Application', extends_class: null, file_path: null }
      : undefined;
  const stmt = {
    all: vi.fn((...params: unknown[]) => (hit(params) ? [hit(params)] : [])),
    get: vi.fn((...params: unknown[]) => hit(params)),
    run: vi.fn(),
  };
  const db = { prepare: vi.fn(() => stmt) };
  return {
    symbolIndex: { db, getReadDb: () => db, getLastIndexedAt: () => null, searchLabels: vi.fn(() => []) } as any,
    parser: {} as any,
    cache: {} as any,
    workspaceScanner: {} as any,
    hybridSearch: {} as any,
  };
};

const req = (name: string, args: Record<string, unknown>): CallToolRequest =>
  ({ method: 'tools/call', params: { name, arguments: args } });
const textOf = (r: any): string => String(r?.content?.[0]?.text ?? '');

beforeEach(() => {
  clearInferredModelPrefixes();
  setModelObjectNameSource(model => (model === MODEL ? MODEL_OBJECTS : []));
  process.env.EXTENSION_PREFIX = PREFIX;
  delete process.env.EXTENSION_SUFFIX;
  delete process.env.EXTENSION_NAMING_STYLE;
  delete process.env.EXTENSION_PREFIX_SOURCE;
});
afterEach(() => {
  setModelObjectNameSource(null);
  clearInferredModelPrefixes();
});

describe('prepare(mode="create") runs the shared naming rules', () => {
  it('reports the missing model prefix the validator reports, not "looks valid"', async () => {
    const validator = textOf(await validateObjectNamingTool(
      req('validate_object_naming', { proposedName: 'CustTable', objectType: 'table' }), buildContext()));
    expect(validator).toMatch(/does not start with model prefix/i);

    const prep = textOf(await prepareCreateTool(
      req('prepare_create', { goal: 'agreement probe', objectName: 'CustTable', objectType: 'table' }),
      buildContext()));

    expect(prep).toMatch(/does not start with model prefix/i);
    expect(prep).not.toContain('Naming looks valid.');
  });

  it('applies the underscore rule, which prepare had no equivalent for', async () => {
    const prep = textOf(await prepareCreateTool(
      req('prepare_create', { goal: 'agreement probe', objectName: 'MyThing_Helper', objectType: 'table' }),
      buildContext()));
    expect(prep).toMatch(/underscore/i);
  });

  it('applies the data-entity convention, which prepare had no equivalent for', async () => {
    const prep = textOf(await prepareCreateTool(
      req('prepare_create', { goal: 'agreement probe', objectName: 'CRThing', objectType: 'data-entity' }),
      buildContext()));
    expect(prep).toMatch(/Entity/);
  });

  it('keeps its own final-name guard (#892/#901), which the shared rules do not cover', async () => {
    // The shared rules see the name the caller typed; this one guards the name the
    // prefix step composed.
    const prep = textOf(await prepareCreateTool(
      req('prepare_create', { goal: 'agreement probe', objectName: 'lowerStart', objectType: 'table' }),
      buildContext()));
    expect(prep).toMatch(/uppercase letter/i);
  });
});

describe('prepare(mode="change") validates an extension name for real', () => {
  it('answers a malformed extension name with the same expected form as the validator', async () => {
    const validator = textOf(await validateObjectNamingTool(
      req('validate_object_naming', {
        proposedName: 'CustTable_Ext', objectType: 'table-extension', baseObjectName: 'CustTable',
      }), buildContext()));
    expect(validator).toMatch(/dot notation/i);

    const prep = textOf(await prepareChangeTool(
      req('prepare_change', {
        goal: 'agreement probe', objectName: 'CustTable', objectType: 'table',
        proposedName: 'CustTable_Ext',
      }), buildContext()));

    expect(prep).toMatch(/dot notation/i);
    // The placeholder that used to be the entire verdict must be gone.
    expect(prep).not.toContain('Confirm naming follows your convention');
  });

  it('accepts a correctly formed element extension', async () => {
    const prep = textOf(await prepareChangeTool(
      req('prepare_change', {
        goal: 'agreement probe', objectName: 'CustTable', objectType: 'table',
        proposedName: 'CustTable.CRExtension',
      }), buildContext()));
    expect(prep).not.toMatch(/dot notation/i);
  });

  it('reads a _Extension name as the CoC class shape, not the element one', async () => {
    const prep = textOf(await prepareChangeTool(
      req('prepare_change', {
        goal: 'agreement probe', objectName: 'CustTable', objectType: 'table',
        proposedName: 'CustTableCR_Extension',
      }), buildContext()));
    // A class extension is not required to use dot notation.
    expect(prep).not.toMatch(/must use dot notation/i);
  });

  /**
   * Reported on the VM while extending `whsWorkExecuteDisplayChangeBatchDisp` —
   * one of the camelCase classes the product ships. The two validators demanded
   * opposite things and NO name satisfied both:
   *   prepare(proposedName="whs…Con_Extension")  -> "must start with an uppercase letter"
   *   validate_object_naming("Whs…Con_Extension") -> "must start with the base class name",
   *                                                  prescribing the name prepare had refused.
   * PascalCase is a rule for a name you invent; an extension name inherits its
   * first letter from a base name the caller did not choose.
   */
  it('does not demand PascalCase from an extension of a camelCase base class', async () => {
    const prep = textOf(await prepareChangeTool(
      req('prepare_change', {
        goal: 'agreement probe', objectName: 'whsWorkExecuteDisplayChangeBatchDisp', objectType: 'class',
        proposedName: 'whsWorkExecuteDisplayChangeBatchDispCR_Extension',
      }), buildContext()));
    expect(prep).not.toMatch(/uppercase letter/i);
  });

  it('still demands PascalCase from a name the caller invented', async () => {
    const prep = textOf(await prepareChangeTool(
      req('prepare_change', {
        goal: 'agreement probe', objectName: 'CustTable', objectType: 'table',
        proposedName: 'lowerStartHelper',
      }), buildContext()));
    expect(prep).toMatch(/uppercase letter/i);
  });

  it('rejects a name that does not start with a letter at all', async () => {
    const prep = textOf(await prepareChangeTool(
      req('prepare_change', {
        goal: 'agreement probe', objectName: 'CustTable', objectType: 'table',
        proposedName: '1Thing',
      }), buildContext()));
    expect(prep).toMatch(/must start with a letter/i);
  });
});

/**
 * The base a check DERIVES from an extension name must not still carry the token the
 * check is about to look for.
 *
 * `CustTableCR_Extension` is the canonical prefix-style name and the write path returns
 * it untouched, yet the check answered "Extension name does not include model's extension
 * infix CR" and recommended `CustTableCRCR_Extension`. Deriving the base as everything
 * before "_Extension" gives `CustTableCR`, which leaves an EMPTY middle for the infix
 * test — the token was eaten by the base. prepare(mode="create") never sends
 * baseObjectName, and the validator's parameter is optional, so the ⚠️ landed on every
 * correctly named extension class asked about through either door. Every test above
 * passes baseObjectName explicitly, which is why none of them saw it.
 */
describe('a derived base does not swallow the token the rules check for', () => {
  it('prepare(mode="create") does not warn about the canonical class-extension name', async () => {
    const prep = textOf(await prepareCreateTool(
      req('prepare_create', { goal: 'agreement probe', objectName: 'CustTableCR_Extension', objectType: 'class-extension' }),
      buildContext()));

    expect(prep).not.toMatch(/does not include model/i);
    expect(prep).not.toMatch(/CustTableCRCR_Extension/);
  });

  it('the validator agrees when baseObjectName is omitted, as prepare omits it', async () => {
    const out = textOf(await validateObjectNamingTool(
      req('validate_object_naming', { proposedName: 'CustTableCR_Extension', objectType: 'class-extension' }),
      buildContext()));

    expect(out).not.toMatch(/does not include model/i);
    // …and the base it reports is the class being extended, not the name minus the word.
    expect(out).toMatch(/Base Object: CustTable$/m);
  });

  it('reports the element, not the stem, for an element-type hint name', async () => {
    // CustTableFormCR_Extension is Microsoft's documented shape for a form CoC class
    // (CustTableFormWHS_Extension); the element it extends is CustTableForm.
    const out = textOf(await validateObjectNamingTool(
      req('validate_object_naming', { proposedName: 'CustTableFormCR_Extension', objectType: 'class-extension' }),
      buildContext()));

    expect(out).not.toMatch(/does not include model/i);
    expect(out).toMatch(/Base Object: CustTableForm$/m);
  });

  it('under model-name style the same holds for the model token', async () => {
    process.env.EXTENSION_NAMING_STYLE = 'model-name';
    const out = textOf(await validateObjectNamingTool(
      req('validate_object_naming', { proposedName: 'CustTable_ContosoRobotics_Extension', objectType: 'class-extension' }),
      buildContext()));

    expect(out).not.toMatch(/does not embed the model/i);
    expect(out).toMatch(/Base Object: CustTable$/m);
  });

  it('still warns when the token really is absent — the strip must not silence the rule', async () => {
    const out = textOf(await validateObjectNamingTool(
      req('validate_object_naming', { proposedName: 'CustTable_Extension', objectType: 'class-extension' }),
      buildContext()));

    expect(out).toMatch(/does not include model/i);
    expect(out).toMatch(/Recommended: CustTableCR_Extension/);
  });
});

/**
 * A name the check passes must also be the name the write path uses.
 *
 * An assembled name like `CustTable_CR_Table_Extension` satisfies every rule — it starts
 * with a base, ends with _Extension, embeds CR — and then lands on disk as
 * `CustTable_CR_TableCR_Extension`, because the trailing "_Extension" makes the whole
 * string read as a base class and the infix is applied a second time. The caller looks
 * for the file under the name it asked for. Same shape as #986/#987, where the checker
 * and the writer disagreed in the other direction.
 */
describe('the check discloses the name the write path will actually use', () => {
  it('names the rewritten form for an assembled extension-class name', async () => {
    const written = normalizeObjectName('CustTable_CR_Table_Extension', 'class-extension', MODEL);
    expect(written).toBe('CustTable_CR_TableCR_Extension');

    const out = textOf(await validateObjectNamingTool(
      req('validate_object_naming', { proposedName: 'CustTable_CR_Table_Extension', objectType: 'class-extension' }),
      buildContext()));

    expect(out).toMatch(/will not use this name as given/i);
    expect(out).toContain(written);
  });

  it('says nothing for a name the write path returns untouched', async () => {
    expect(normalizeObjectName('CustTableCR_Extension', 'class-extension', MODEL)).toBe('CustTableCR_Extension');

    const out = textOf(await validateObjectNamingTool(
      req('validate_object_naming', { proposedName: 'CustTableCR_Extension', objectType: 'class-extension' }),
      buildContext()));

    expect(out).not.toMatch(/will not use this name as given/i);
  });

  it('converting a model-name name to prefix style leaves no stray separator', async () => {
    // The strip took the token off and kept the underscore it sat behind, so the infix
    // landed one character late: CustTable_ → CustTable_CR_Extension, where every name
    // of this shape in PackagesLocalDirectory is spelled CustTableCR_Extension.
    expect(normalizeObjectName('CustTable_ContosoRobotics_Extension', 'class-extension', MODEL))
      .toBe('CustTableCR_Extension');
  });
});
