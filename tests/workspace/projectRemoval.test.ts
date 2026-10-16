import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  scaffoldProject, removeProject, removeProjectFromSolutionText, parseSolutionProjects,
  addProjectToSolutionText, ScaffoldError,
} from '../../src/workspace/projectScaffold.js';
import { ProjectFileManager } from '../../src/workspace/projectFile.js';
import { registerCustomModel } from '../../src/utils/modelClassifier.js';
import { d365foFileTool } from '../../src/tools/d365foFile.js';
import { getConfigManager } from '../../src/utils/configManager.js';

const BASE_SLN = '﻿' + [
  '',
  'Microsoft Visual Studio Solution File, Format Version 12.00',
  '# Visual Studio Version 17',
  'Project("{FC65038C-1B2F-41E1-A629-BED71D161FFF}") = "T-001", "T-001\\T-001.rnrproj", "{11111111-1111-1111-1111-111111111111}"',
  'EndProject',
  'Global',
  '\tGlobalSection(SolutionConfigurationPlatforms) = preSolution',
  '\t\tDebug|Any CPU = Debug|Any CPU',
  '\tEndGlobalSection',
  '\tGlobalSection(ProjectConfigurationPlatforms) = postSolution',
  '\t\t{11111111-1111-1111-1111-111111111111}.Debug|Any CPU.ActiveCfg = Debug|Any CPU',
  '\t\t{11111111-1111-1111-1111-111111111111}.Debug|Any CPU.Build.0 = Debug|Any CPU',
  '\tEndGlobalSection',
  'EndGlobal',
  '',
].join('\r\n');

let root: string;
beforeEach(async () => {
  registerCustomModel('ContosoCore');
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'remove-project-'));
  await fs.mkdir(path.join(root, 'T-001'));
  await fs.writeFile(path.join(root, 'T-001', 'T-001.rnrproj'),
    '<Project xmlns="http://schemas.microsoft.com/developer/msbuild/2003"><PropertyGroup><Model>ContosoCore</Model></PropertyGroup></Project>');
  await fs.writeFile(path.join(root, 'ContosoCore.sln'), BASE_SLN, 'utf-8');
  // The temp folder stands in for a configured solution root (project-path containment).
  getConfigManager().setRuntimeContext({ solutionPath: root });
});
afterEach(async () => {
  getConfigManager().setRuntimeContext({ solutionPath: undefined });
  await fs.rm(root, { recursive: true, force: true });
});

const sln = () => fs.readFile(path.join(root, 'ContosoCore.sln'), 'utf-8');
const exists = (p: string) => fs.access(p).then(() => true, () => false);

describe('removeProjectFromSolutionText', () => {
  it('is the inverse of add: text round-trips exactly', () => {
    const plain = BASE_SLN.slice(1);
    const added = addProjectToSolutionText(plain, {
      displayName: 'X', relPath: 'X\\X.rnrproj', guid: '{22222222-2222-2222-2222-222222222222}', dependsOnGuids: [],
    });
    expect(removeProjectFromSolutionText(added, 'X\\X.rnrproj')!.text).toBe(plain);
  });

  it('drops dependency lines other projects hold, and an emptied section', () => {
    const withDep = addProjectToSolutionText(BASE_SLN.slice(1), {
      displayName: 'X', relPath: 'X\\X.rnrproj', guid: '{22222222-2222-2222-2222-222222222222}',
      dependsOnGuids: ['{11111111-1111-1111-1111-111111111111}'],
    });
    const out = removeProjectFromSolutionText(withDep, 'T-001\\T-001.rnrproj')!.text;
    expect(out).not.toContain('11111111-1111');
    expect(out).not.toContain('ProjectDependencies');
    expect(parseSolutionProjects(out).map(p => p.name)).toEqual(['X']);
  });

  it('returns null for a project that is not listed', () => {
    expect(removeProjectFromSolutionText(BASE_SLN, 'Nope\\Nope.rnrproj')).toBeNull();
  });
});

describe('removeProject', () => {
  it('unregisters from the solution and leaves the files by default', async () => {
    const r = await removeProject({ projectPath: path.join(root, 'T-001', 'T-001.rnrproj'), removeFiles: false });
    expect(r.solutions).toEqual([path.join(root, 'ContosoCore.sln')]);
    expect((await sln()).charCodeAt(0)).toBe(0xFEFF);
    expect(parseSolutionProjects(await sln())).toEqual([]);
    expect(await exists(path.join(root, 'T-001', 'T-001.rnrproj'))).toBe(true);
  });

  it('create then delete leaves the solution as it was', async () => {
    const r = await scaffoldProject({
      projectName: 'T-002', modelName: 'ContosoCore', projectsRoot: root, solutionMode: 'auto',
    });
    await removeProject({ projectPath: r.projectPath, removeFiles: true });
    expect(await sln()).toBe(BASE_SLN);
    expect(await exists(path.join(root, 'T-002'))).toBe(false);
  });

  it('removeFiles refuses a folder with foreign content and changes nothing', async () => {
    await fs.writeFile(path.join(root, 'T-001', 'notes.txt'), 'keep me');
    await expect(removeProject({ projectPath: path.join(root, 'T-001', 'T-001.rnrproj'), removeFiles: true }))
      .rejects.toThrow(/notes\.txt/);
    expect(await sln()).toBe(BASE_SLN);
    expect(await exists(path.join(root, 'T-001', 'T-001.rnrproj'))).toBe(true);
  });

  it('removes a per-project solution together with its folder', async () => {
    await fs.rm(path.join(root, 'ContosoCore.sln'));
    const r = await scaffoldProject({
      projectName: 'T-003', modelName: 'ContosoCore', projectsRoot: root, solutionMode: 'per-project',
    });
    await fs.mkdir(path.join(root, 'T-003', 'obj'));
    await removeProject({ projectPath: r.projectPath, removeFiles: true });
    expect(await exists(path.join(root, 'T-003'))).toBe(false);
  });

  it('reports elements no other project references, and never touches metadata', async () => {
    const a = path.join(root, 'T-001', 'T-001.rnrproj');
    const b = await scaffoldProject({ projectName: 'T-002', modelName: 'ContosoCore', projectsRoot: root, solutionMode: 'auto' });
    const mgr = new ProjectFileManager();
    await mgr.addToProject(a, 'class', 'OnlyHere', '');
    await mgr.addToProject(a, 'class', 'Shared', '');
    await mgr.addToProject(b.projectPath, 'class', 'Shared', '');
    const r = await removeProject({ projectPath: a, removeFiles: false, otherProjectPaths: [a, b.projectPath] });
    expect(r.orphanedElements).toEqual(['axclass\\onlyhere']);
  });

  it('refuses a project listed in no solution, and a non-project path', async () => {
    await fs.mkdir(path.join(root, 'Loose'));
    await fs.writeFile(path.join(root, 'Loose', 'Loose.rnrproj'), '<Project/>');
    await expect(removeProject({ projectPath: path.join(root, 'Loose', 'Loose.rnrproj'), removeFiles: false }))
      .rejects.toThrow(/not listed in any solution/);
    await expect(removeProject({ projectPath: path.join(root, 'ContosoCore.sln'), removeFiles: false }))
      .rejects.toBeInstanceOf(ScaffoldError);
  });
});

describe('d365fo_file(action="project", operation="delete")', () => {
  const call = (params: Record<string, unknown>) =>
    d365foFileTool({ method: 'tools/call', params: { name: 'd365fo_file', arguments: { action: 'project', params: { operation: 'delete', ...params } } } } as any, {} as any);

  it('removes the project by name and says metadata was not touched', async () => {
    const r: any = await call({ projectName: 'T-001', projectsRoot: root, modelName: 'ContosoCore' });
    expect(r.isError, r.content[0].text).toBeFalsy();
    expect(r.content[0].text).toContain('Model metadata was NOT touched');
    expect(parseSolutionProjects(await sln())).toEqual([]);
  });

  // %TEMP% itself passed the old "looks like a projects folder" test — other runs leave
  // .sln files one folder down — so only the solution-listing check stopped this. The
  // configured roots stop it first.
  it('refuses a path outside the configured solution roots', async () => {
    const stray = await fs.mkdtemp(path.join(os.tmpdir(), 'stray-'));
    try {
      await fs.writeFile(path.join(stray, 'Z.rnrproj'), '<Project/>');
      const r: any = await call({ projectPath: path.join(stray, 'Z.rnrproj'), removeFiles: true });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain('outside the configured solution roots');
      expect(await exists(path.join(stray, 'Z.rnrproj'))).toBe(true);
    } finally { await fs.rm(stray, { recursive: true, force: true }); }
  });

  it('rejects a traversing projectName', async () => {
    const r: any = await call({ projectName: '..\\..\\x', projectsRoot: root });
    expect(r.isError).toBe(true);
  });
});
