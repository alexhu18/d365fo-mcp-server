/**
 * get_workspace_info(diagnostics=true) must read the descriptor the
 * module-reference writers write.
 *
 * It used to probe only `<root>/<Model>/Descriptor/<Model>.xml`, while the
 * writer (findModelDescriptorPath) also finds a model inside a differently-named
 * package. For such an ISV model, add-module-reference succeeded and the tool
 * the op spec points at for reading the list then called it UNKNOWN.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import type { XppServerContext } from '../../src/types/context.js';

const MODEL = 'IsvCore';
const state = { root: '' };

vi.mock('../../src/utils/configManager', () => {
  const manager = {
    ensureLoaded: async () => {},
    getModelName: () => MODEL,
    getWriteAnchorModel: () => MODEL,
    getAutoDetectedModelName: async () => MODEL,
    getRawAutoDetectedModelName: () => MODEL,
    getAllDetectedProjects: () => [],
    getAmbiguousProjectPaths: () => [],
    getToolProjectSwitch: () => null,
    getDevEnvironmentType: async () => 'local',
    getMicrosoftPackagesPath: async () => null,
    getCustomPackagesPath: async () => state.root,
    getPackagePath: () => null,
    forceProject: async () => null,
    getWorkspaceInfoDiagnostics: async () => ({
      modelName: MODEL,
      modelSource: 'test',
      isModelSourceAutoDetected: false,
      projectPath: null,
      projectSource: 'not selected',
      ambiguousProjects: [],
      packagePath: null,
      packageSource: 'test',
      customPackagesPath: state.root,
      customPackagesSource: 'test',
    }),
  };
  return { getConfigManager: vi.fn(() => manager), fallbackPackagePath: () => null };
});

import { getWorkspaceInfoTool } from '../../src/tools/readers/getWorkspaceInfo.js';

const buildContext = (): XppServerContext => {
  const stmt = { all: vi.fn(() => []), get: vi.fn(() => undefined), run: vi.fn() };
  const db = { prepare: vi.fn(() => stmt) };
  return {
    symbolIndex: { db, getReadDb: () => db, getLastIndexedAt: () => null } as any,
    parser: {} as any,
    cache: {} as any,
    workspaceScanner: {} as any,
    hybridSearch: {} as any,
  };
};

beforeAll(async () => {
  state.root = await fs.mkdtemp(path.join(os.tmpdir(), 'wsinfo-descriptor-'));
  // The model lives in a package that is NOT named after it.
  const dir = path.join(state.root, 'IsvPackage', 'Descriptor');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, `${MODEL}.xml`),
    `<AxModelInfo xmlns:d2p1="x">\n  <ModuleReferences>\n` +
      `    <d2p1:string>ApplicationSuite</d2p1:string>\n    <d2p1:string>Ledger</d2p1:string>\n` +
      `  </ModuleReferences>\n</AxModelInfo>`,
    'utf-8',
  );
});

afterAll(async () => {
  await fs.rm(state.root, { recursive: true, force: true });
});

describe('get_workspace_info module references', () => {
  it('lists the references of a model inside a differently-named package', async () => {
    const request: CallToolRequest = {
      method: 'tools/call',
      params: { name: 'get_workspace_info', arguments: { diagnostics: true } },
    };
    const result: any = await getWorkspaceInfoTool(request, buildContext());
    const text = String(result.content[0].text);

    expect(text).toContain(`## Module References (${MODEL})`);
    expect(text).not.toContain('UNKNOWN');
    expect(text).toContain('  - ApplicationSuite');
    expect(text).toContain('  - Ledger');
    expect(text).toContain(path.join('IsvPackage', 'Descriptor', `${MODEL}.xml`));
  });
});
