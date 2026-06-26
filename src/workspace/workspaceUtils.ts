/**
 * Workspace utilities
 * Path validation and security helpers
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { assertReadRootAllowed } from '../utils/pathContainment.js';

/**
 * Validate workspace path
 * Ensures path is safe and accessible, and that it is contained within the
 * configured D365FO package roots.
 *
 * Security: the previous implementation only checked for the literal substring
 * ".." — absolute paths such as "/etc" or "C:\Windows" bypassed it entirely.
 * This version resolves the path to an absolute form and then verifies it falls
 * under one of the operator-configured package roots before any fs operation.
 */
export async function validateWorkspacePath(workspacePath: string): Promise<{
  valid: boolean;
  error?: string;
}> {
  try {
    // Resolve to absolute, eliminating any relative segments.
    const resolved = path.resolve(workspacePath);

    // Root-containment check: reject any path that does not resolve under a
    // configured D365FO package root (replaces the old ".." substring test,
    // which was bypassable with absolute paths such as "/etc" or "C:\Windows").
    const containment = await assertReadRootAllowed(resolved);
    if (!containment.ok) {
      return {
        valid: false,
        error: containment.reason ?? 'workspacePath escapes configured workspace roots',
      };
    }

    // Check if path exists and is a directory.
    try {
      const stats = await fs.stat(resolved);
      if (!stats.isDirectory()) {
        return {
          valid: false,
          error: 'Workspace path must be a directory',
        };
      }
    } catch (error) {
      return {
        valid: false,
        error: `Workspace path does not exist or is not accessible: ${resolved}`,
      };
    }

    // Check if path contains too many files (prevent DoS)
    const files = await fs.readdir(resolved);
    if (files.length > 50000) {
      return {
        valid: false,
        error: 'Workspace contains too many files (max 50,000). Please use a more specific path.',
      };
    }

    return { valid: true };
  } catch (error) {
    return {
      valid: false,
      error: `Error validating workspace path: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }
}

/**
 * Sanitize workspace path
 * Remove any potentially dangerous characters
 */
export function sanitizeWorkspacePath(workspacePath: string): string {
  // Normalize path separators
  let sanitized = path.normalize(workspacePath);

  // Remove any null bytes
  sanitized = sanitized.replace(/\0/g, '');

  // Ensure absolute path
  if (!path.isAbsolute(sanitized)) {
    sanitized = path.resolve(sanitized);
  }

  return sanitized;
}

/**
 * Check if path is within allowed bounds
 */
export function isPathWithinBounds(basePath: string, targetPath: string): boolean {
  const normalizedBase = path.normalize(basePath);
  const normalizedTarget = path.normalize(targetPath);

  const relative = path.relative(normalizedBase, normalizedTarget);
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}
