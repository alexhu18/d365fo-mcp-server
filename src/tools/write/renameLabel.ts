/**
 * Rename Label Tool
 *
 * Renames a label ID across ALL places where it appears:
 *  1. Every .label.txt file in the model (the label entry itself)
 *  2. Every X++ source file (.xpp) referencing @LabelFileId:OldId
 *  3. Every XML metadata file referencing @LabelFileId:OldId in properties
 *     such as <Label>, <HelpText>, <Caption>, <Description>, <Tooltip>, etc.
 *  4. Updates the MCP SQLite label index
 *
 * The search covers only the model's own package directory by default, but can be
 * extended to additional directories via the `searchPaths` parameter.
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { writeFileAtomic } from '../../utils/atomicFileWrite.js';
import { z } from 'zod';
import type { XppServerContext } from '../../types/context.js';
import { promises as fs } from 'fs';
import * as path from 'path';
import { getConfigManager } from '../../utils/configManager.js';
import { defaultPackagesRoot } from '../../utils/packagesRoot.js';
import { PackageResolver } from '../../utils/packageResolver.js';
import { detectEol } from '../../utils/eolUtils.js';
import { isExtensionLabelFile } from '../../metadata/labelParser.js';
import { crossModelWriteRefusal, standDownNotice } from '../../utils/crossModelWriteGuard.js';
import { resolveAnchorModel } from './writeAnchorGuard.js';
import { assertWritePathAllowed, isFileUnderRoot } from '../../utils/pathContainment.js';

const UTF8_BOM = '\uFEFF';

const RenameLabelArgsSchema = z.object({
  oldLabelId: z
    .string()
    .describe('Current label ID to rename, e.g. MyOldField'),
  newLabelId: z
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9_]*$/, 'New label ID must be alphanumeric (no spaces)')
    .describe('New label ID, e.g. MyRenamedField'),
  labelFileId: z
    .string()
    .describe('Label file ID that owns the label (e.g. ContosoExt, ContosoCore)'),
  model: z
    .string()
    .describe('Model name that owns the label file (e.g. ContosoExt)'),
  packageName: z
    .string()
    .optional()
    .describe('Package name for the model. Auto-resolved if omitted.'),
  packagePath: z
    .string()
    .optional()
    .describe('Root PackagesLocalDirectory path. Auto-detected if omitted.'),
  searchPaths: z
    .array(z.string())
    .optional()
    .describe(
      'Additional absolute directory paths to scan for X++ / XML references. ' +
      'The model package directory is always included automatically.',
    ),
  allowExtensionLabelFile: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      'Escape hatch to allow operating on a label file EXTENSION (a labelFileId ' +
        'carrying the "_Extension" marker). Off by default: labels belong in the ' +
        "model's own ORIGINAL label file, not in an extension.",
    ),
  dryRun: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      'If true, report all files that would be changed without writing anything. ' +
      'Use this first to preview the impact.',
    ),
  updateIndex: z
    .boolean()
    .optional()
    .default(true)
    .describe('Update the MCP label index after renaming (default: true)'),
});

/** Strip UTF-8 BOM from string */
function stripBom(s: string): string {
  return s.startsWith(UTF8_BOM) ? s.slice(1) : s;
}

/** Escape string for use in a regex */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The label ID a .label.txt line declares, or null for a comment (" ;…"), blank
 * or malformed line. The one reading of a line that the existence check, the
 * collision check and the rewrite share: when the checks searched the raw text
 * for "\n<id>=" or "<BOM><id>=", a label on the first line of a file without a
 * BOM was invisible to them but not to the rewrite, and renaming onto it left
 * two declarations of the same ID.
 */
function labelIdOfLine(line: string): string | null {
  if (line.startsWith(' ;') || line.startsWith('\t;')) return null;
  const eqIdx = line.indexOf('=');
  if (eqIdx <= 0) return null;
  const id = line.substring(0, eqIdx).trim();
  return id && !/\s/.test(id) ? id : null;
}

/** Lines of a .label.txt, without its BOM and line endings. */
function labelLines(content: string): string[] {
  return stripBom(content).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
}

/** Whether a .label.txt declares `labelId`. */
function declaresLabel(content: string, labelId: string): boolean {
  return labelLines(content).some(line => labelIdOfLine(line) === labelId);
}

/**
 * Rename a label entry inside a single .label.txt file.
 * Returns the new file content, or null if the label was not found.
 */
function renameLabelInTxt(content: string, oldId: string, newId: string): string | null {
  // Preserve the original line-ending style — D365FO .label.txt files are CRLF
  // in TFVC/Git, and silently rewriting them as LF makes every line look modified.
  // The BOM stays as it was for the same reason: adding one to a file that had
  // none shows up as a change to its first line.
  const eol = detectEol(content);
  let found = false;
  const out: string[] = [];

  for (const line of labelLines(content)) {
    if (labelIdOfLine(line) === oldId) {
      found = true;
      out.push(newId + line.substring(line.indexOf('='))); // replace only the ID part
      continue;
    }
    out.push(line);
  }

  if (!found) return null;
  return (content.startsWith(UTF8_BOM) ? UTF8_BOM : '') + out.join(eol);
}

/**
 * Replace all occurrences of @LabelFileId:OldId with @LabelFileId:NewId in arbitrary text.
 * Handles both quoted and unquoted occurrences (X++ literalStr and XML properties).
 * Returns { newContent, count } — count = 0 means no replacements.
 */
function replaceReferences(
  content: string,
  labelFileId: string,
  oldId: string,
  newId: string,
): { newContent: string; count: number } {
  const pattern = new RegExp(
    `@${escapeRegex(labelFileId)}:${escapeRegex(oldId)}(?=[^A-Za-z0-9_]|$)`,
    'g',
  );
  let count = 0;
  const newContent = content.replace(pattern, () => {
    count++;
    return `@${labelFileId}:${newId}`;
  });
  return { newContent, count };
}

/** Recursively collect all files with given extensions under a directory */
async function collectFiles(dir: string, extensions: string[]): Promise<string[]> {
  const results: string[] = [];
  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await collectFiles(full, extensions)));
    } else if (extensions.some(ext => entry.name.endsWith(ext))) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Why each of `files` — reference rewrites outside the label's own model
 * directory — may not be written, or [] when all of them may. A file must lie
 * under a configured package root in the AOT layout, and its model must pass
 * the cross-model guard, exactly as a d365fo_file write into it would.
 */
async function refuseReferenceWritesOutsideModel(
  files: string[],
  labelRef: string,
  configManager: ReturnType<typeof getConfigManager>,
): Promise<string[]> {
  if (files.length === 0) return [];
  const activeModel = await resolveAnchorModel(configManager);
  const refusals: string[] = [];
  for (const file of files) {
    const contained = await assertWritePathAllowed(file);
    if (!contained.ok) {
      refusals.push(`${file} — outside the configured package roots or not an AOT object file`);
      continue;
    }
    const refusal = crossModelWriteRefusal({
      objectName: labelRef,
      objectType: 'label',
      owningModel: contained.modelSegment,
      owningPackage: contained.packageSegment,
      activeModel,
      action: 'modify',
    });
    if (refusal) refusals.push(`${file} — in model "${contained.modelSegment}", this workspace targets "${activeModel}"`);
  }
  return refusals;
}

export async function renameLabelTool(request: CallToolRequest, context: XppServerContext) {
  try {
    const args = RenameLabelArgsSchema.parse(request.params.arguments);
    const { oldLabelId, newLabelId, labelFileId, model, dryRun, updateIndex } = args;
    const { symbolIndex } = context;

    if (oldLabelId === newLabelId) {
      return {
        content: [{ type: 'text', text: `⚠️ Old and new label IDs are identical ("${oldLabelId}"). Nothing to do.` }],
        isError: true,
      };
    }

    // Labels belong in the model's own original label file, not an extension; opt out with allowExtensionLabelFile=true.
    if (isExtensionLabelFile(labelFileId) && !args.allowExtensionLabelFile) {
      return {
        content: [{
          type: 'text',
          text:
            `❌ "${labelFileId}" is a label file EXTENSION, not an original label file.\n\n` +
            `Labels belong in the model's own (original) label file — extensions (…_Extension…) ` +
            `only extend a base label file owned by another model.\n\n` +
            `➡️  List the model's label files with labels(action="info", model="${model}") ` +
            `and re-run with the original labelFileId.\n\n` +
            `If you really must operate on this extension, pass allowExtensionLabelFile=true.`,
        }],
        isError: true,
      };
    }

    // Resolve package path
    const configManager = getConfigManager();
    const envType = await configManager.getDevEnvironmentType();

    let resolvedPackagePath: string;
    let resolvedPackageName: string;

    if (args.packageName) {
      resolvedPackageName = args.packageName;
      if (envType === 'ude') {
        const customPath = await configManager.getCustomPackagesPath();
        resolvedPackagePath = args.packagePath || customPath || configManager.getPackagePath() || defaultPackagesRoot();
      } else {
        resolvedPackagePath = args.packagePath || configManager.getPackagePath() || defaultPackagesRoot();
      }
    } else if (envType === 'ude') {
      const customPath = await configManager.getCustomPackagesPath();
      const msPath = await configManager.getMicrosoftPackagesPath();
      const roots = [customPath, msPath].filter(Boolean) as string[];
      resolvedPackagePath = args.packagePath || customPath || defaultPackagesRoot();
      const resolver = new PackageResolver(roots);
      const resolved = await resolver.resolve(model);
      resolvedPackageName = resolved?.packageName || model;
      if (resolved?.rootPath) resolvedPackagePath = resolved.rootPath;
    } else {
      resolvedPackagePath = args.packagePath || configManager.getPackagePath() || defaultPackagesRoot();
      resolvedPackageName = model;
    }

    // Cross-model guard, as labels(create) applies it: the rename rewrites the
    // owning model's label file, and another model's label file is that model's
    // code. Checked for a dry run too — previewing a rename the real call would
    // refuse only plans work that cannot be done.
    const crossModelCheck = {
      objectName: `@${labelFileId}:${oldLabelId}`,
      objectType: 'label',
      owningModel: model,
      owningPackage: resolvedPackageName,
      activeModel: await resolveAnchorModel(configManager),
      toolSwitchedModel: configManager.getToolProjectSwitch()?.forcedModel ?? null,
      action: 'modify' as const,
      dryRun,
    };
    const crossModelRefusal = crossModelWriteRefusal(crossModelCheck);
    if (crossModelRefusal) {
      return { content: [{ type: 'text', text: crossModelRefusal }], isError: true };
    }
    const crossModelNotice = standDownNotice(crossModelCheck);

    const modelDir = path.join(resolvedPackagePath, resolvedPackageName, model);
    const labelResourcesDir = path.join(modelDir, 'AxLabelFile', 'LabelResources');

    // Check old label exists in at least one .label.txt
    let existingLanguages: string[] = [];
    try {
      existingLanguages = await fs.readdir(labelResourcesDir);
    } catch {
      return {
        content: [{
          type: 'text',
          text: `❌ AxLabelFile LabelResources directory not found:\n  ${labelResourcesDir}\n\nCheck that labelFileId, model and packagePath are correct.`,
        }],
        isError: true,
      };
    }

    // Verify old label exists
    let foundInAny = false;
    for (const lang of existingLanguages) {
      const txtPath = path.join(labelResourcesDir, lang, `${labelFileId}.${lang}.label.txt`);
      try {
        const content = await fs.readFile(txtPath, 'utf-8');
        if (declaresLabel(content, oldLabelId)) {
          foundInAny = true;
          break;
        }
      } catch { /* skip missing files */ }
    }

    if (!foundInAny) {
      return {
        content: [{
          type: 'text',
          text:
            `❌ Label "${oldLabelId}" not found in any .label.txt file of ` +
            `label file "${labelFileId}" in model "${model}".\n\n` +
            `Use labels(action="search") or labels(action="info") to verify the label ID and label file.`,
        }],
        isError: true,
      };
    }

    // Check new label ID doesn't already exist
    for (const lang of existingLanguages) {
      const txtPath = path.join(labelResourcesDir, lang, `${labelFileId}.${lang}.label.txt`);
      try {
        const content = await fs.readFile(txtPath, 'utf-8');
        if (declaresLabel(content, newLabelId)) {
          return {
            content: [{
              type: 'text',
              text:
                `❌ Target label ID "${newLabelId}" already exists in ` +
                `"${labelFileId}.${lang}.label.txt". Choose a different new label ID.`,
            }],
            isError: true,
          };
        }
      } catch { /* skip */ }
    }

    // Collect all files to scan for references. A file reachable from both the
    // model directory and a searchPath is one file: rewritten (and counted) once.
    const scanRoots = [modelDir, ...(args.searchPaths ?? [])];
    const uniqueFiles = (files: string[]) => [...new Map(files.map(f => [path.resolve(f).toLowerCase(), f])).values()];
    const allXppFiles = uniqueFiles(
      (await Promise.all(scanRoots.map(d => collectFiles(d, ['.xpp'])))).flat(),
    );
    const allXmlFiles = uniqueFiles(
      (await Promise.all(scanRoots.map(d => collectFiles(d, ['.xml'])))).flat(),
    );

    // Everything is computed before anything is written: a reference rewrite the
    // guard below refuses must stop the whole rename, or the label would be
    // renamed with some of its references left pointing at the old ID.
    type FileChange = { file: string; replacements: number };
    type PendingWrite = { file: string; content: string };
    const labelTxtChanges: FileChange[] = [];
    const xppChanges: FileChange[] = [];
    const xmlChanges: FileChange[] = [];
    const pendingWrites: PendingWrite[] = [];

    // Phase: rename in .label.txt files
    for (const lang of existingLanguages) {
      const txtPath = path.join(labelResourcesDir, lang, `${labelFileId}.${lang}.label.txt`);
      let content: string;
      try {
        content = await fs.readFile(txtPath, 'utf-8');
      } catch { continue; }

      const newContent = renameLabelInTxt(content, oldLabelId, newLabelId);
      if (newContent === null) continue;

      labelTxtChanges.push({ file: txtPath, replacements: 1 });
      pendingWrites.push({ file: txtPath, content: newContent });
    }

    // Phase: replace @LabelFileId:OldId references in .xpp files
    for (const xppFile of allXppFiles) {
      let content: string;
      try {
        content = await fs.readFile(xppFile, 'utf-8');
      } catch { continue; }

      const { newContent, count } = replaceReferences(content, labelFileId, oldLabelId, newLabelId);
      if (count === 0) continue;

      xppChanges.push({ file: xppFile, replacements: count });
      pendingWrites.push({ file: xppFile, content: newContent });
    }

    // Phase: replace references in XML metadata files
    for (const xmlFile of allXmlFiles) {
      // AxLabelFile XML descriptors don't contain label refs
      if (xmlFile.includes('AxLabelFile')) continue;

      let content: string;
      try {
        content = await fs.readFile(xmlFile, 'utf-8');
      } catch { continue; }

      const { newContent, count } = replaceReferences(content, labelFileId, oldLabelId, newLabelId);
      if (count === 0) continue;

      xmlChanges.push({ file: xmlFile, replacements: count });
      pendingWrites.push({ file: xmlFile, content: newContent });
    }

    // searchPaths is the caller's to choose, so a reference found through it can
    // sit in any model — or outside every package root. The label-file check
    // above says nothing about those files: without this, renaming a label of the
    // workspace's own model with searchPaths pointed at another model rewrote
    // that model's objects. Each file outside the model directory must pass the
    // same containment and cross-model checks a d365fo_file write does.
    const outsideRefusals = await refuseReferenceWritesOutsideModel(
      pendingWrites.map(w => w.file).filter(f => !isFileUnderRoot(f, modelDir)),
      `@${labelFileId}:${oldLabelId}`,
      configManager,
    );
    if (outsideRefusals.length > 0) {
      return {
        content: [{
          type: 'text',
          text:
            `⛔ Refusing to rename "@${labelFileId}:${oldLabelId}" — ${outsideRefusals.length} of the references ` +
            `found through searchPaths are in files this workspace may not write. Nothing was ${dryRun ? 'previewed' : 'written'}: ` +
            `a partial rename leaves references to an ID that no longer exists.\n\n` +
            outsideRefusals.slice(0, 10).map(r => `  • ${r}`).join('\n') +
            (outsideRefusals.length > 10 ? `\n  • … and ${outsideRefusals.length - 10} more` : '') +
            `\n\nDrop those directories from searchPaths. References in another model are that model's code — ` +
            `they change when its owner renames them, not from this workspace.`,
        }],
        isError: true,
      };
    }

    if (!dryRun) {
      for (const w of pendingWrites) await writeFileAtomic(w.file, w.content);
    }

    // Update SQLite index
    if (!dryRun && updateIndex && labelTxtChanges.length > 0) {
      symbolIndex.renameLabelInIndex(oldLabelId, newLabelId, labelFileId, model);
    }

    // Build result summary
    const totalFiles =
      labelTxtChanges.length + xppChanges.length + xmlChanges.length;
    const totalReplacements =
      labelTxtChanges.reduce((s, c) => s + c.replacements, 0) +
      xppChanges.reduce((s, c) => s + c.replacements, 0) +
      xmlChanges.reduce((s, c) => s + c.replacements, 0);

    const oldRef = `@${labelFileId}:${oldLabelId}`;
    const newRef = `@${labelFileId}:${newLabelId}`;

    const lines: string[] = [];

    if (dryRun) {
      lines.push(`🔍 DRY RUN — no files were modified`);
      lines.push(`   "${oldRef}" → "${newRef}"`);
    } else {
      lines.push(`✅ Label renamed: "${oldRef}" → "${newRef}"`);
    }

    lines.push('');
    lines.push(`📊 Summary: ${totalFiles} file(s) ${dryRun ? 'would be' : ''} changed, ${totalReplacements} replacement(s)`);
    lines.push('');

    if (labelTxtChanges.length > 0) {
      lines.push(`🏷️  .label.txt files (${labelTxtChanges.length}):`);
      for (const c of labelTxtChanges) {
        const lang = path.basename(path.dirname(c.file));
        lines.push(`   ${dryRun ? '○' : '✔'} [${lang}] ${path.basename(c.file)}`);
      }
      lines.push('');
    }

    if (xppChanges.length > 0) {
      lines.push(`📄 X++ source files (${xppChanges.length} file(s), ${xppChanges.reduce((s, c) => s + c.replacements, 0)} occurrence(s)):`);
      for (const c of xppChanges) {
        lines.push(`   ${dryRun ? '○' : '✔'} ${c.file}  (${c.replacements}×)`);
      }
      lines.push('');
    }

    if (xmlChanges.length > 0) {
      lines.push(`📋 XML metadata files (${xmlChanges.length} file(s), ${xmlChanges.reduce((s, c) => s + c.replacements, 0)} occurrence(s)):`);
      for (const c of xmlChanges) {
        lines.push(`   ${dryRun ? '○' : '✔'} ${c.file}  (${c.replacements}×)`);
      }
      lines.push('');
    }

    if (xppChanges.length === 0 && xmlChanges.length === 0) {
      lines.push(`ℹ️  No X++ or XML references to "${oldRef}" found in scanned directories.`);
      lines.push(`   If the label is used in code, add its directory to the searchPaths parameter.`);
      lines.push('');
    }

    if (!dryRun) {
      lines.push('💡 Rebuild your D365FO project to verify no compile errors.');
    }

    if (dryRun && totalFiles > 0) {
      lines.push(`💡 Remove dryRun=true to apply the rename.`);
    }

    if (crossModelNotice) lines.push(crossModelNotice.trim());

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  } catch (err: any) {
    return {
      content: [{ type: 'text', text: `Error renaming label: ${err.message}` }],
      isError: true,
    };
  }
}
