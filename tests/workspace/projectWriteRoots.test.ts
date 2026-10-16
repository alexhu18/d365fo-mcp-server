/**
 * Every tool that writes a .rnrproj on a caller's behalf is bounded by the solution
 * roots d365fo_file(action="project") already enforced. create's addToProject used to
 * write any .rnrproj it was handed — action="project" add-object then refused the very
 * project create had just registered three objects into.
 *
 * A projectPath the USER configured (D365FO_PROJECT_PATH / config file) vouches for its
 * own folder, as does a project the server detected itself; a project a tool call
 * activated (forceProject) does not.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ProjectFileManager, registerFileInActiveProject } from '../../src/workspace/projectFile.js';
import { assertProjectPathAllowed } from '../../src/utils/pathContainment.js';
import { getConfigManager } from '../../src/utils/configManager.js';
import { registerCustomModel } from '../../src/utils/modelClassifier.js';

const RNRPROJ =
  '<?xml version="1.0" encoding="utf-8"?>\n' +
  '<Project xmlns="http://schemas.microsoft.com/developer/msbuild/2003">\n' +
  '  <PropertyGroup><Model>ContosoRobotics</Model></PropertyGroup>\n' +
  '  <ItemGroup />\n' +
  '</Project>\n';

async function projectIn(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await fs.mkdir(path.join(dir, 'CR-001'));
  const projectPath = path.join(dir, 'CR-001', 'CR-001.rnrproj');
  await fs.writeFile(projectPath, RNRPROJ);
  return projectPath;
}

const cfg: any = getConfigManager();
let ownProject: string;
let foreignProject: string;
let saved: Record<string, unknown>;
let savedEnv: string | undefined;

beforeEach(async () => {
  registerCustomModel('ContosoRobotics');
  await cfg.ensureLoaded();
  saved = {
    autoDetectedProject: cfg.autoDetectedProject, autoDetectionAttempted: cfg.autoDetectionAttempted,
    toolForcedProject: cfg.toolForcedProject, runtimeContext: cfg.runtimeContext,
    lastForcedProjectPath: cfg.lastForcedProjectPath, serverDetectedProjectPath: cfg.serverDetectedProjectPath,
  };
  savedEnv = process.env.D365FO_PROJECT_PATH;
  delete process.env.D365FO_PROJECT_PATH;
  ownProject = await projectIn('own-');
  foreignProject = await projectIn('foreign-');
  cfg.setRuntimeContext({ solutionPath: path.dirname(path.dirname(ownProject)) });
});
afterEach(async () => {
  Object.assign(cfg, saved);
  if (savedEnv === undefined) delete process.env.D365FO_PROJECT_PATH; else process.env.D365FO_PROJECT_PATH = savedEnv;
  await fs.rm(path.dirname(path.dirname(ownProject)), { recursive: true, force: true });
  await fs.rm(path.dirname(path.dirname(foreignProject)), { recursive: true, force: true });
});

describe('ProjectFileManager({ withinSolutionRoots: true })', () => {
  const guarded = () => new ProjectFileManager({ withinSolutionRoots: true });

  it('adds to a project under a configured root', async () => {
    expect(await guarded().addToProject(ownProject, 'class', 'CRThing', '')).toBe(true);
    expect(await fs.readFile(ownProject, 'utf-8')).toContain('AxClass\\CRThing');
  });

  it('refuses a project outside the roots and leaves it byte-for-byte as it was', async () => {
    await expect(guarded().addToProject(foreignProject, 'class', 'CRThing', ''))
      .rejects.toThrow(/outside the configured solution roots/);
    await expect(guarded().addLabelToProject(foreignProject, 'CRLabels', ['en-US']))
      .rejects.toThrow(/outside the configured solution roots/);
    await expect(guarded().removeFromProject(foreignProject, 'class', 'CRThing'))
      .rejects.toThrow(/outside the configured solution roots/);
    expect(await fs.readFile(foreignProject, 'utf-8')).toBe(RNRPROJ);
  });

  it('is opt-in: a manager built without it writes where it is told', async () => {
    expect(await new ProjectFileManager().addToProject(foreignProject, 'class', 'CRThing', '')).toBe(true);
  });
});

describe('which projects vouch for their own folder', () => {
  it('a projectPath the user configured does', async () => {
    process.env.D365FO_PROJECT_PATH = foreignProject;
    expect((await assertProjectPathAllowed(foreignProject)).ok).toBe(true);
  });

  it('a project a tool call activated does not', async () => {
    expect(await cfg.forceProject(foreignProject)).not.toBeNull();
    expect((await assertProjectPathAllowed(foreignProject)).ok).toBe(false);
  });

  it('a project the server detected on its own does — a zero-config install still registers', async () => {
    cfg.lastForcedProjectPath = null;
    cfg.autoDetectedProject = {
      projectPath: foreignProject,
      modelName: 'ContosoRobotics',
      solutionPath: path.dirname(path.dirname(foreignProject)),
    };
    expect((await assertProjectPathAllowed(foreignProject)).ok).toBe(true);
    const note = await registerFileInActiveProject('class', 'CRThing', 'ContosoRobotics', foreignProject);
    expect(note).toContain('added it to');
  });

  /**
   * An agent routinely "confirms" its project with get_workspace_info(projectPath=…)
   * naming the very project the server detected. That went through forceProject,
   * which marked it tool-activated — and from then on every create, label and
   * modify registration into it was refused as outside the solution roots.
   */
  describe('a tool call re-selecting the project the server detected', () => {
    // After the detection beforeEach started, so it cannot overwrite this one.
    const detect = async (projectPath: string) => {
      await cfg.awaitPendingDetection();
      cfg.lastForcedProjectPath = null;
      cfg.serverDetectedProjectPath = null;
      cfg.autoDetectedProject = {
        projectPath, modelName: 'ContosoRobotics', solutionPath: path.dirname(path.dirname(projectPath)),
      };
    };

    it('leaves it detected, so it keeps its root', async () => {
      await detect(foreignProject);
      expect(await cfg.forceProject(foreignProject)).not.toBeNull();
      expect((await assertProjectPathAllowed(foreignProject)).ok).toBe(true);
    });

    it('also after switching away to another project and back', async () => {
      await detect(foreignProject);
      const elsewhere = await projectIn('elsewhere-');
      try {
        expect(await cfg.forceProject(elsewhere)).not.toBeNull();
        expect((await assertProjectPathAllowed(elsewhere)).ok).toBe(false);
        expect(await cfg.forceProject(foreignProject)).not.toBeNull();
        expect((await assertProjectPathAllowed(foreignProject)).ok).toBe(true);
      } finally {
        await fs.rm(path.dirname(path.dirname(elsewhere)), { recursive: true, force: true });
      }
    });
  });
});

describe('registerFileInActiveProject (create/modify on an existing, unregistered file)', () => {
  it('reports the refusal instead of writing a project outside the roots', async () => {
    const note = await registerFileInActiveProject('class', 'CRThing', 'ContosoRobotics', foreignProject);
    expect(note).toMatch(/Could not add/);
    expect(note).toContain('outside the configured solution roots');
    expect(await fs.readFile(foreignProject, 'utf-8')).toBe(RNRPROJ);
  });

  it('still registers into a project under the roots', async () => {
    const note = await registerFileInActiveProject('class', 'CRThing', 'ContosoRobotics', ownProject);
    expect(note).toContain('added it to');
    expect(await fs.readFile(ownProject, 'utf-8')).toContain('AxClass\\CRThing');
  });
});

/**
 * get_workspace_info(projectPath=…) switches to a project outside the roots without
 * a word, and every create after it writes the object and then reports "failed to
 * add to project". The switch itself is the moment to say so — and which setting
 * makes the project a root.
 */
describe('get_workspace_info(projectPath=…) outside the solution roots', () => {
  const context = (): any => {
    const stmt = { all: () => [], get: () => undefined, run: () => {} };
    const db = { prepare: () => stmt };
    return { symbolIndex: { db, getReadDb: () => db, getLastIndexedAt: () => null }, parser: {}, cache: {}, workspaceScanner: {}, hybridSearch: {} };
  };
  const switchTo = async (projectPath: string): Promise<string> => {
    const { getWorkspaceInfoTool } = await import('../../src/tools/readers/getWorkspaceInfo.js');
    const r = await getWorkspaceInfoTool({ method: 'tools/call', params: { name: 'get_workspace_info', arguments: { projectPath } } } as any, context());
    return String(r.content[0].text);
  };

  it('warns at the switch, naming workspace.solutionsPath', async () => {
    const text = await switchTo(foreignProject);
    expect(text.split('\n')[0]).toMatch(/^⚠️ Switched to .*outside the configured solution roots/);
    expect(text).toContain('workspace.solutionsPath');
  });

  it('says nothing for a project under the roots', async () => {
    expect(await switchTo(ownProject)).not.toContain('outside the configured solution roots');
  });
});
