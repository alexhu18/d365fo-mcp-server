/**
 * d365fo_file(action="project") writes and deletes .rnrproj/.sln files, which live in a
 * repo rather than under the package roots, so the AOT containment never covered them.
 * Before this, the only bound was "the folder looks like a projects folder" — true of
 * every Visual Studio repo on the machine, and of %TEMP% itself. The bound is now the
 * configured solution roots: D365FO_SOLUTIONS_PATH, workspacePath, solutionPath.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { d365foFileTool } from '../../src/tools/d365foFile.js';
import { assertProjectPathAllowed } from '../../src/utils/pathContainment.js';
import { getConfigManager } from '../../src/utils/configManager.js';
import { registerCustomModel } from '../../src/utils/modelClassifier.js';

const SLN = [
  'Microsoft Visual Studio Solution File, Format Version 12.00',
  'Project("{FC65038C-1B2F-41E1-A629-BED71D161FFF}") = "T-001", "T-001\\T-001.rnrproj", "{11111111-1111-1111-1111-111111111111}"',
  'EndProject',
  'Global',
  '\tGlobalSection(ProjectConfigurationPlatforms) = postSolution',
  '\t\t{11111111-1111-1111-1111-111111111111}.Debug|Any CPU.ActiveCfg = Debug|Any CPU',
  '\tEndGlobalSection',
  'EndGlobal',
  '',
].join('\r\n');
const RNRPROJ = '<Project xmlns="http://schemas.microsoft.com/developer/msbuild/2003"><PropertyGroup><Model>ContosoCore</Model></PropertyGroup></Project>';

/** A projects folder as VS leaves it: a shared .sln listing one project. */
async function projectsFolder(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await fs.mkdir(path.join(dir, 'T-001'));
  await fs.writeFile(path.join(dir, 'T-001', 'T-001.rnrproj'), RNRPROJ);
  await fs.writeFile(path.join(dir, 'ContosoCore.sln'), SLN);
  return dir;
}

const call = (params: Record<string, unknown>) =>
  d365foFileTool({
    method: 'tools/call',
    params: { name: 'd365fo_file', arguments: { action: 'project', params: { modelName: 'ContosoCore', ...params } } },
  } as any, {} as any) as Promise<any>;

const cfg: any = getConfigManager();
let own: string;     // the configured solution root
let foreign: string; // another repo's projects folder on the same machine
let saved: Record<string, unknown>;

beforeEach(async () => {
  registerCustomModel('ContosoCore');
  await cfg.ensureLoaded();
  saved = {
    autoDetectedProject: cfg.autoDetectedProject, autoDetectionAttempted: cfg.autoDetectionAttempted,
    toolForcedProject: cfg.toolForcedProject, runtimeContext: cfg.runtimeContext,
  };
  own = await projectsFolder('own-');
  foreign = await projectsFolder('foreign-');
  cfg.setRuntimeContext({ solutionPath: own });
});
afterEach(async () => {
  Object.assign(cfg, saved);
  await fs.rm(own, { recursive: true, force: true });
  await fs.rm(foreign, { recursive: true, force: true });
});

describe('assertProjectPathAllowed', () => {
  it('accepts a path under a configured root and refuses one beside it', async () => {
    expect((await assertProjectPathAllowed(path.join(own, 'T-001', 'T-001.rnrproj'))).ok).toBe(true);
    const r = await assertProjectPathAllowed(path.join(foreign, 'T-001', 'T-001.rnrproj'));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('outside the configured solution roots');
    expect(r.reason).toContain('D365FO_SOLUTIONS_PATH');
  });

  it('a folder that only shares the root name as a prefix is not under it', async () => {
    expect((await assertProjectPathAllowed(`${own}-evil${path.sep}X.rnrproj`)).ok).toBe(false);
  });

  it('refuses a path that climbs out of the root through ..', async () => {
    expect((await assertProjectPathAllowed(path.join(own, '..', path.basename(foreign), 'T-001', 'T-001.rnrproj'))).ok).toBe(false);
  });

  it('a solutionPath naming the .sln file bounds its folder', async () => {
    cfg.setRuntimeContext({ solutionPath: path.join(own, 'ContosoCore.sln') });
    expect((await assertProjectPathAllowed(path.join(own, 'T-001', 'T-001.rnrproj'))).ok).toBe(true);
  });

  it('D365FO_SOLUTIONS_PATH is a root on its own', async () => {
    cfg.setRuntimeContext({ solutionPath: undefined });
    const prev = process.env.D365FO_SOLUTIONS_PATH;
    process.env.D365FO_SOLUTIONS_PATH = foreign;
    try {
      expect((await assertProjectPathAllowed(path.join(foreign, 'T-001', 'T-001.rnrproj'))).ok).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.D365FO_SOLUTIONS_PATH; else process.env.D365FO_SOLUTIONS_PATH = prev;
    }
  });
});

describe('d365fo_file(action="project") stays inside the configured roots', () => {
  it('create refuses another repo\'s projects folder and writes nothing there', async () => {
    const r = await call({ operation: 'create', projectName: 'X-1', projectsRoot: foreign, activate: false });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('outside the configured solution roots');
    expect(await fs.readFile(path.join(foreign, 'ContosoCore.sln'), 'utf-8')).toBe(SLN);
    await expect(fs.access(path.join(foreign, 'X-1'))).rejects.toThrow();
  });

  it('create still works in the configured root', async () => {
    const r = await call({ operation: 'create', projectName: 'X-1', projectsRoot: own, activate: false });
    expect(r.isError, r.content[0].text).toBeFalsy();
  });

  it('delete refuses another repo\'s project, however well a solution vouches for it', async () => {
    const r = await call({ operation: 'delete', projectPath: path.join(foreign, 'T-001', 'T-001.rnrproj'), removeFiles: true });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('outside the configured solution roots');
    expect(await fs.readFile(path.join(foreign, 'ContosoCore.sln'), 'utf-8')).toBe(SLN);
    expect(await fs.readFile(path.join(foreign, 'T-001', 'T-001.rnrproj'), 'utf-8')).toBe(RNRPROJ);
  });

  // The shared .sln delete rewrites sits beside the project folder: a root that is
  // the project folder itself does not cover it.
  it('delete refuses when the root covers the project folder but not the solution beside it', async () => {
    cfg.setRuntimeContext({ solutionPath: path.join(own, 'T-001') });
    const r = await call({ operation: 'delete', projectPath: path.join(own, 'T-001', 'T-001.rnrproj') });
    expect(r.isError).toBe(true);
    expect(await fs.readFile(path.join(own, 'ContosoCore.sln'), 'utf-8')).toBe(SLN);
  });

  it('add-object refuses another repo\'s project', async () => {
    const r = await call({
      operation: 'add-object', projectPath: path.join(foreign, 'T-001', 'T-001.rnrproj'), objectType: 'class', objectName: 'X',
    });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('outside the configured solution roots');
    expect(await fs.readFile(path.join(foreign, 'T-001', 'T-001.rnrproj'), 'utf-8')).toBe(RNRPROJ);
  });

  // The active project does not move the bound: create activates what it makes, so a
  // root taken from the active project would let one call vouch for the next.
  it('an active project in a foreign folder is refused too', async () => {
    expect(await cfg.forceProject(path.join(foreign, 'T-001', 'T-001.rnrproj'))).not.toBeNull();
    const r = await call({ operation: 'remove-object', objectType: 'class', objectName: 'X', allowOrphan: true });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('outside the configured solution roots');
  });
});
