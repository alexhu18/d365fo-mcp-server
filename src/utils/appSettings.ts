/**
 * `<appSettings>` values out of a .NET .config document (web.config,
 * SysTestConsole.exe.config).
 *
 * Only flat `<add key="…" value="…"/>` entries are ever read, so this stays a
 * small reader rather than a full XML parse — but it reads them as XML does:
 *   - commented-out entries do not count. A web.config routinely keeps the
 *     previous value in a comment next to the live one, and a reader that saw
 *     the comment first answered with the OLD host or database;
 *   - attribute order and quote style are free (`value="…" key="…"`,
 *     `key='…'`);
 *   - entities are decoded, so `a&amp;b` reads as `a&b`;
 *   - only entries inside `<appSettings>` count when the document has one —
 *     `<add>` is also the element of connectionStrings, handlers, modules and
 *     most other collections;
 *   - a key added twice takes its last value, as .NET's appSettings does.
 */

const COMMENT_OR_CDATA = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/g;
const APP_SETTINGS_SECTION = /<appSettings(?:\s[^>]*)?>([\s\S]*?)<\/appSettings\s*>/gi;
// Quoted values may contain ">" — XML only requires "<" and "&" to be escaped there.
const ADD_ELEMENT = /<add\s((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;
const ATTRIBUTE = /([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[name.toLowerCase()] ?? whole;
  });
}

function attributesOf(tag: string): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const m of tag.matchAll(ATTRIBUTE)) attrs.set(m[1].toLowerCase(), decodeEntities(m[2] ?? m[3] ?? ''));
  return attrs;
}

/** The value of one `<appSettings>` key, or undefined when no live entry sets it. */
export function readAppSetting(xml: string, key: string): string | undefined {
  // Replaced by a space, not removed: deleting a comment joins the text around
  // it, and "<!" + "<!-- … -->" + "--" would then read as a new "<!--" that the
  // single pass never sees. A space keeps the two sides apart, as XML does.
  const live = xml.replace(COMMENT_OR_CDATA, ' ');
  const wanted = key.toLowerCase();
  // A fragment with no <appSettings> wrapper is read whole.
  const sections = [...live.matchAll(APP_SETTINGS_SECTION)].map(m => m[1]);
  let value: string | undefined;
  for (const section of sections.length > 0 ? sections : [live]) {
    for (const [, tag] of section.matchAll(ADD_ELEMENT)) {
      const attrs = attributesOf(tag);
      if (attrs.get('key')?.toLowerCase() === wanted && attrs.has('value')) value = attrs.get('value');
    }
  }
  return value;
}
