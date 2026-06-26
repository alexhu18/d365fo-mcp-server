import { execFile } from 'child_process';
import util from 'util';
import path from 'path';
import fs from 'fs/promises';
import { getConfigManager } from '../utils/configManager.js';
import { withOperationLock } from '../utils/operationLocks.js';

const execFileAsync = util.promisify(execFile);

// Keyword that xppbp.exe prints when it doesn't recognise the arguments
const HELP_TEXT_PATTERN = /^usage:|BPCheck Tool|^xppbp\.exe|unrecognized|missing required|X\+\+ Best Practice Options/im;

// Tool registration (name, description, inputSchema) lives inline in
// src/server/mcpServer.ts - the single source of truth for tool instructions.

/**
 * Attempt to run xppbp.exe with a given set of args.
 * Returns { stdout, stderr } or throws on non-zero exit / timeout.
 */
async function tryXppbp(xppbpPath: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(xppbpPath, args, {
    maxBuffer: 10 * 1024 * 1024,
    timeout: 300_000 // 5 minutes
  });
}

export const runBpCheckTool = async (params: any, _context: any) => {
  const { targetFilter, targetElementType } = params;
  try {
    const configManager = getConfigManager();
    await configManager.ensureLoaded();

    // Resolve model name
    const modelName = params.modelName || configManager.getModelName();
    if (!modelName) {
      return {
        content: [{ type: 'text', text: '❌ Cannot determine model name.\n\nProvide modelName parameter or set it in .mcp.json.' }],
        isError: true
      };
    }

    // Resolve project path — optional in UDE environments where xppbp no longer requires -vsproj
    const resolvedProjectPath = params.projectPath || await configManager.getProjectPath();

    // In UDE the custom packages path (ModelStoreFolder) is the metadata root,
    // while the framework packages path (FrameworkDirectory) is the binaries root.
    // For traditional environments both roles are served by packagesRoot.
    //
    // Path resolution — intentionally mirrors build_d365fo_project:
    //   Priority 1: XPP config file (UDE — authoritative when present).
    //               Note: when an XPP config exists, any customPackagesPath /
    //               microsoftPackagesPath values in .mcp.json are NOT consulted.
    //               Use params.packagePath to override the final packagesRoot.
    //   Priority 2: configManager methods (.mcp.json context overrides, then
    //               XPP config auto-detection as a second chance for CHE).
    //   Priority 3: Well-known PackagesLocalDirectory probe (CHE fallback).
    let customPackagesPath: string | null = null;
    let microsoftPackagesPath: string | null = null;
    const xppConfig = await configManager.getActiveXppConfig();
    if (xppConfig) {
      customPackagesPath = xppConfig.customPackagesPath;
      microsoftPackagesPath = xppConfig.microsoftPackagesPath;
    }

    // Priority 2: configManager explicit methods (.mcp.json overrides)
    if (!customPackagesPath)    customPackagesPath    = await configManager.getCustomPackagesPath();
    if (!microsoftPackagesPath) microsoftPackagesPath = await configManager.getMicrosoftPackagesPath();

    // Priority 3: probe well-known PackagesLocalDirectory locations (CHE)
    if (!microsoftPackagesPath) {
      for (const candidate of [
        'C:\\AOSService\\PackagesLocalDirectory',
        'K:\\AOSService\\PackagesLocalDirectory',
        'J:\\AOSService\\PackagesLocalDirectory',
        'I:\\AOSService\\PackagesLocalDirectory',
      ]) {
        try { await fs.access(candidate); microsoftPackagesPath = candidate; break; } catch { /* next */ }
      }
    }

    // In CHE, custom and Microsoft packages share the same PackagesLocalDirectory
    if (!customPackagesPath && microsoftPackagesPath) customPackagesPath = microsoftPackagesPath;

    // Final packagesRoot: explicit param override → microsoft path → custom path → legacy env var → hardcoded default
    const packagesRoot = params.packagePath
      || microsoftPackagesPath
      || customPackagesPath
      || configManager.getPackagePath()
      || 'K:\\AosService\\PackagesLocalDirectory';

    // Locate xppbp.exe — always in the Microsoft/framework packages Bin, not the custom model folder.
    const xppbpPath = path.join(packagesRoot, 'Bin', 'xppbp.exe');
    try {
      await fs.access(xppbpPath);
    } catch {
      return {
        content: [{ type: 'text', text: `❌ xppbp.exe not found at: ${xppbpPath}\n\nMake sure XPP_CONFIG_NAME is set correctly in your instance .env so the FrameworkDirectory is resolved automatically.` }],
        isError: true
      };
    }

    // metadataPath: where X++ source XML lives (custom model metadata)
    const metadataPath = customPackagesPath || packagesRoot;
    // compilerMetadataPath: where compiled binaries and framework metadata live.
    // In UDE: the framework/Microsoft packages root
    // In CHE: same as metadataPath (both roles in one PackagesLocalDirectory)
    const compilerMetadataPath = microsoftPackagesPath || packagesRoot;

    /**
     * xppbp.exe CLI flag styles observed across versions:
     *
     *   Style A — colon separator (older):
     *     -metadata:<path>  -module:<name>  -model:<name>  -compilerMetadata:<path>  -all
     *     -filter:<name>  (filter by element name)
     *
     *   Style B — equals separator (newer, 10.0.24+):
     *     -metadata=<path>  -module=<name>  -model=<name>  -compilerMetadata=<path>  -all
     *     class:<Name>  (positional element-type filter, e.g. "class:MyClass")
     *
     *   Style C — fallback (when -compilerMetadata is not recognized):
     *     -metadata:<path>  -packagesRoot:<path>  -module:<name>  -model:<name>  -all
     *
     * We try A → B → C in order, stopping at the first that doesn't return help text.
     * In UDE, metadataPath and compilerMetadataPath are different directories.
     * In CHE, they may be the same (both in PackagesLocalDirectory).
     */

    // Style A — colon separator with -compilerMetadata
    const buildArgsColonStyle = (metadataFlag: string, compilerMetadataFlag: string): string[] => {
      const a: string[] = [
        `${metadataFlag}${metadataPath}`,
        `-module:${modelName}`,
        `-model:${modelName}`,
        `${compilerMetadataFlag}${compilerMetadataPath}`,
        `-all`,
      ];
      if (targetFilter) a.push(`-filter:${targetFilter}`);
      return a;
    };

    // Style B — equals separator (xppbp 10.0.24+: positional "<type>:<Name>" filter, no leading dash)
    const buildArgsEqStyle = ({ compilerMetadata }: { compilerMetadata: boolean }): string[] => {
      const a: string[] = [
        `-metadata=${metadataPath}`,
        `-module=${modelName}`,
        `-model=${modelName}`,
      ];

      // -compilerMetadata= is the newer flag; fall back to -packagesRoot= for older xppbp
      if (compilerMetadata) {
        a.push(`-compilerMetadata=${compilerMetadataPath}`);
      } else {
        a.push(`-packagesRoot=${compilerMetadataPath}`);
      }

      a.push(`-all`);

      // Positional element filter: "<type>:<Name>" — type comes from targetElementType
      // (defaults to 'class' when omitted for backwards compatibility).
      if (targetFilter) {
        const elemType = (targetElementType ?? 'class').toLowerCase();
        a.push(`${elemType}:${targetFilter}`);
      }
      return a;
    };

    // Style C — fallback when -compilerMetadata is not recognized
    const buildArgsFallbackStyle = (): string[] => {
      const a: string[] = [
        `-metadata:${metadataPath}`,
        `-packagesRoot:${compilerMetadataPath}`,
        `-module:${modelName}`,
        `-model:${modelName}`,
        `-all`,
      ];
      if (targetFilter) a.push(`-filter:${targetFilter}`);
      return a;
    };

    let stdout = '';
    let stderr = '';

    const { combined, lastStdout, lastStderr } = await withOperationLock(
      `bp:${modelName}`,
      async () => {
        // --- Attempt 1: colon style with -compilerMetadata: (UDE: separates custom and framework paths) ---
        const args1 = buildArgsColonStyle('-metadata:', '-compilerMetadata:');
        console.error(`[run_bp_check] Attempt 1 (-compilerMetadata: colon): "${xppbpPath}" ${args1.join(' ')}`);
        try {
          ({ stdout, stderr } = await tryXppbp(xppbpPath, args1));
        } catch (e: any) {
          stdout = e.stdout ?? '';
          stderr = e.stderr ?? '';
        }
        let localCombined = [stdout, stderr].filter(Boolean).join('\n').trim();

        // --- Attempt 2: equals style with -compilerMetadata= (xppbp 10.0.24+) ---
        if (HELP_TEXT_PATTERN.test(localCombined) || localCombined === '') {
          const args2 = buildArgsEqStyle({ compilerMetadata: true });
          console.error(`[run_bp_check] Attempt 2 (-compilerMetadata= equals): "${xppbpPath}" ${args2.join(' ')}`);
          try {
            ({ stdout, stderr } = await tryXppbp(xppbpPath, args2));
          } catch (e: any) {
            stdout = e.stdout ?? '';
            stderr = e.stderr ?? '';
          }
          localCombined = [stdout, stderr].filter(Boolean).join('\n').trim();
        }

        // --- Attempt 3: equals style with -packagesRoot= (fallback for older xppbp) ---
        if (HELP_TEXT_PATTERN.test(localCombined) || localCombined === '') {
          const args3 = buildArgsEqStyle({ compilerMetadata: false });
          console.error(`[run_bp_check] Attempt 3 (-packagesRoot= equals fallback): "${xppbpPath}" ${args3.join(' ')}`);
          try {
            ({ stdout, stderr } = await tryXppbp(xppbpPath, args3));
          } catch (e: any) {
            stdout = e.stdout ?? '';
            stderr = e.stderr ?? '';
          }
          localCombined = [stdout, stderr].filter(Boolean).join('\n').trim();
        }

        // --- Attempt 4: colon style with -packagesRoot: (oldest fallback) ---
        if (HELP_TEXT_PATTERN.test(localCombined) || localCombined === '') {
          const args4 = buildArgsFallbackStyle();
          console.error(`[run_bp_check] Attempt 4 (-packagesRoot: colon fallback): "${xppbpPath}" ${args4.join(' ')}`);
          try {
            ({ stdout, stderr } = await tryXppbp(xppbpPath, args4));
          } catch (e: any) {
            stdout = e.stdout ?? '';
            stderr = e.stderr ?? '';
          }
          localCombined = [stdout, stderr].filter(Boolean).join('\n').trim();
        }

        return { combined: localCombined, lastStdout: stdout, lastStderr: stderr };
      },
    );

    stdout = lastStdout;
    stderr = lastStderr;

    // If still showing help text, report a useful diagnostic
    if (HELP_TEXT_PATTERN.test(combined)) {
      return {
        content: [{
          type: 'text',
          text: `❌ xppbp.exe returned its help text for all four flag-style attempts (-compilerMetadata:, -compilerMetadata=, -packagesRoot= with equals, -packagesRoot: with colon).\n\nThis usually means the installed xppbp.exe version uses an unrecognised CLI format.\n\nRaw output:\n\n${combined}`
        }],
        isError: true
      };
    }

    // Use stdout/stderr directly — xppbp prints violations as plain text.
    // (-car: generates an Excel file which is not human-readable as text.)
    const logContent = combined;

    // Detect violations in output.
    // xppbp emits two distinct line patterns:
    //   Errors:   "BPError..." or XML <Diagnostic severity="error">
    //   Warnings: "BestPractices Warning: ..." or "BestPractices Error: ..."
    // Both must trigger the warning status — a warning is still a violation.
    const hasIssues = /BPError|<Diagnostic|severity="error"|BestPractices (Warning|Error):/i.test(logContent)
      || /BPError|severity\s*[:=]\s*error/i.test(combined)
      || /^Warnings:\s*[1-9]/m.test(combined)
      || /^Errors:\s*[1-9]/m.test(combined);

    const summary = hasIssues ? '⚠️ BP Check completed with issues' : '✅ BP Check passed';
    const details = logContent || combined || '(no output)';

    return {
      content: [{
        type: 'text',
        text: `${summary}\n\nModel: ${modelName}` +
          (resolvedProjectPath ? `\nProject: ${resolvedProjectPath}` : '') +
          (targetFilter ? `\nFilter: ${targetFilter}` : '') +
          `\n\n${details}`
      }]
    };
  } catch (error: any) {
    console.error('Error running BP Check:', error);
    const output = [error.stdout, error.stderr, error.message].filter(Boolean).join('\n');
    return {
      content: [{ type: 'text', text: '❌ BP Check failed:\n\n' + output }],
      isError: true
    };
  }
};
