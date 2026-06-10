/**
 * EOL (line ending) detection utilities for file-writing operations.
 *
 * D365FO .label.txt files are Windows-native CRLF by convention (TFVC and Git
 * both track them as CRLF). Tools that read-normalize-write must preserve the
 * original line ending so VCS diffs only highlight the intentional changes.
 */

/**
 * Detect the dominant line ending in a file's content.
 *
 * Strategy: first-CRLF-wins — any CRLF in the file is treated as evidence that
 * the whole file is CRLF (the realistic D365FO failure mode is "tool stripped CRs
 * from a CRLF file", not a genuinely mixed-EOL file we need to majority-vote on).
 * Falls back to LF only when line endings are present but none are CRLF.
 * Defaults to CRLF for brand-new or empty files to match D365FO conventions.
 */
export function detectEol(content: string): '\r\n' | '\n' {
  if (content.includes('\r\n')) return '\r\n';
  if (content.includes('\n')) return '\n';
  return '\r\n';
}
