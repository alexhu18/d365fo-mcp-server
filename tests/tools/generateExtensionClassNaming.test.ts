/**
 * generate_object(mode="pattern") must name an extension class exactly what
 * d365fo_file(action="create") will write for it.
 *
 * The pattern generator assembled its class names by hand, always as
 * `{Base}{Infix}…_Extension`, while the writer normalises every `_Extension` name
 * through normalizeObjectName. The two disagreed in every style:
 *   - prefix style: `SalesTableCRForm_Extension` and `SalesTable_SalesLineCRDS_Extension`
 *     were written as `SalesTableCRFormCR_Extension` / `…CRDSCR_Extension` — the writer
 *     puts the token right before "_Extension" unless it already ends there;
 *   - model-name class style (EXTENSION_NAMING_STYLE, or EXTENSION_CLASS_NAMING_STYLE):
 *     ignored outright, so every skeleton carried the prefix infix and was renamed on
 *     create, the `final class` declaration with it.
 *
 * Runs the REAL modelClassifier and objectNaming — only configManager is mocked — so
 * "the writer leaves the generated name alone" is checked against the writer itself.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { codeGenTool } from '../../src/tools/smart/codeGen.js';
import { normalizeObjectName } from '../../src/utils/objectNaming.js';
import { setModelObjectNameSource, clearInferredModelPrefixes } from '../../src/utils/modelPrefixInference.js';

const MODEL = 'ContosoRobotics';
const PREFIX = 'CR';
const MODEL_OBJECTS = Array.from({ length: 40 }, (_, i) => `CRObject${i}`);

vi.mock('../../src/utils/configManager', () => ({
  getConfigManager: vi.fn(() => ({
    getModelName: () => MODEL,
    getWriteAnchorModel: () => MODEL,
    getToolProjectSwitch: () => null,
  })),
}));

const CASES = [
  { pattern: 'class-extension', name: 'SalesFormLetter', stem: 'SalesFormLetter' },
  { pattern: 'table-extension', name: 'CustTable', stem: 'CustTable' },
  { pattern: 'map-extension', name: 'InventItemOrdered', stem: 'InventItemOrdered' },
  { pattern: 'form-handler', name: 'SalesTable', stem: 'SalesTableForm' },
  { pattern: 'form-datasource-extension', name: 'SalesTable', baseName: 'SalesLine', stem: 'SalesTable_SalesLineDS' },
  { pattern: 'form-control-extension', name: 'SalesTable', baseName: 'SalesId', stem: 'SalesTable_SalesIdCtrl' },
] as const;

const generate = async (args: Record<string, unknown>): Promise<string> => {
  const request: CallToolRequest = {
    method: 'tools/call',
    params: { name: 'generate_object', arguments: { modelName: MODEL, ...args } },
  };
  const result: any = await codeGenTool(request);
  expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
  return result.content.map((c: any) => c.text).join('\n');
};

const declaredClass = (text: string): string => {
  const m = /final class (\w+)/.exec(text);
  expect(m, 'no class declaration in the skeleton').not.toBeNull();
  return m![1];
};

const originalEnv = { ...process.env };

beforeEach(() => {
  clearInferredModelPrefixes();
  setModelObjectNameSource(model => (model === MODEL ? MODEL_OBJECTS : []));
  process.env.EXTENSION_PREFIX = PREFIX;
  delete process.env.EXTENSION_SUFFIX;
  delete process.env.EXTENSION_PREFIX_SOURCE;
  delete process.env.EXTENSION_NAMING_STYLE;
  delete process.env.EXTENSION_CLASS_NAMING_STYLE;
  delete process.env.GROUNDING_ENFORCE;
});

afterEach(() => {
  setModelObjectNameSource(null);
  clearInferredModelPrefixes();
  process.env = { ...originalEnv };
});

const STYLES = [
  { label: 'prefix (default)', env: {}, tail: `${PREFIX}_Extension` },
  { label: 'model-name', env: { EXTENSION_NAMING_STYLE: 'model-name' }, tail: `_${MODEL}_Extension` },
  {
    label: 'model-name elements, prefix classes',
    env: { EXTENSION_NAMING_STYLE: 'model-name', EXTENSION_CLASS_NAMING_STYLE: 'prefix' },
    tail: `${PREFIX}_Extension`,
  },
  {
    label: 'prefix elements, model-name classes',
    env: { EXTENSION_CLASS_NAMING_STYLE: 'model-name' },
    tail: `_${MODEL}_Extension`,
  },
] as const;

describe('generate_object extension classes carry the name create writes', () => {
  for (const style of STYLES) {
    for (const c of CASES) {
      it(`${c.pattern} under ${style.label}`, async () => {
        Object.assign(process.env, style.env);
        const text = await generate({ pattern: c.pattern, name: c.name, ...('baseName' in c ? { baseName: c.baseName } : {}) });
        const cls = declaredClass(text);

        // The property that matters: create leaves this name exactly as generated.
        expect(normalizeObjectName(cls, 'class-extension', MODEL)).toBe(cls);
        // …and it is the style's shape, with the token placed once.
        expect(cls).toBe(`${c.stem}${style.tail}`);
        // The note names the same class the skeleton declares.
        expect(text).toContain(`Generated class: \`${cls}\``);
      });
    }
  }

  it('no longer produces the double infix the writer used to add', async () => {
    const ds = declaredClass(await generate({ pattern: 'form-datasource-extension', name: 'SalesTable', baseName: 'SalesLine' }));
    const form = declaredClass(await generate({ pattern: 'form-handler', name: 'SalesTable' }));
    for (const cls of [ds, form]) {
      expect(cls.match(new RegExp(PREFIX, 'g'))?.length, cls).toBe(1);
    }
  });
});
