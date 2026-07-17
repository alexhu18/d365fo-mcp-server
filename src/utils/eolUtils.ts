/**
 * EOL (line ending) detection utilities for file-writing operations.
 *
 * D365FO .label.txt files are Windows-native CRLF by convention (TFVC and Git
 * both track them as CRLF). Tools that read-normalize-write must preserve the
 * original line ending so VCS diffs only highlight the intentional changes.
 */

/**
 * Detect the dominant line ending in a file's content.
 * Any CRLF present is treated as evidence the whole file is CRLF; falls back
 * to LF only when line endings exist but none are CRLF. Defaults to CRLF for
 * brand-new or empty files to match D365FO conventions.
 */
export function detectEol(content: string): '\r\n' | '\n' {
  if (content.includes('\r\n')) return '\r\n';
  if (content.includes('\n')) return '\n';
  return '\r\n';
}
