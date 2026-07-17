/**
 * Normalize content destined for a D365FO metadata XML file on disk so it
 * matches Microsoft's serialization convention: no UTF-8 BOM, CRLF line
 * endings, no trailing newline. Without this, tool-created files show up in
 * TFVC/Git as if every line had been modified. Only applied to custom-model
 * files the MCP server writes itself — never to OOB Microsoft files.
 */
export function normalizeD365Xml(content: string): string {
  // Strip a leading UTF-8 BOM (U+FEFF)
  if (content.charCodeAt(0) === 0xFEFF) {
    content = content.slice(1);
  }
  // Collapse existing CRLF to LF first so mixed-EOL input doesn't double up as CRCRLF.
  content = content.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
  // Strip a single trailing newline
  if (content.endsWith('\r\n')) {
    content = content.slice(0, -2);
  } else if (content.endsWith('\n')) {
    content = content.slice(0, -1);
  }
  return content;
}
