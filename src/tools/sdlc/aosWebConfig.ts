/**
 * The local AOS's own address, for `restartAos` without an explicit `aosUrl`.
 *
 * A classic AOSService VM's AOS reads its root URL from `Infrastructure.HostUrl`
 * in AosService\WebRoot\web.config, next to the PackagesLocalDirectory the build
 * already resolved. Reading it there spares the caller the URL — the very value
 * the restart then has to match against exactly one local IIS/IIS Express
 * binding, so a hand-typed variant of it only produced a blocked restart.
 *
 * A UDE machine has no local AOS and no such file: callers get null and keep
 * requiring the explicit root.
 */
import { readFile } from 'fs/promises';
import path from 'path';
import { readAppSetting } from '../../utils/appSettings.js';

export interface LocalAosUrl {
  /** Environment root, e.g. https://usnconeboxax1aos.cloud.onebox.dynamics.com/ */
  url: string;
  /** The web.config it came from. */
  source: string;
}

/** Environment root named by the web.config beside the first packages root that has one. */
export async function localAosUrl(packagesRoots: Array<string | null | undefined>): Promise<LocalAosUrl | null> {
  for (const root of new Set(packagesRoots.filter((r): r is string => !!r))) {
    const source = path.join(root, '..', 'WebRoot', 'web.config');
    let xml: string;
    try {
      xml = await readFile(source, 'utf-8');
    } catch {
      continue;
    }
    const value = readAppSetting(xml, 'Infrastructure.HostUrl')?.trim();
    if (!value) continue;
    try {
      const url = new URL(value);
      if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) {
        return { url: `${url.origin}/`, source };
      }
    } catch {
      // Not a URL: fall through to the next root, or to the explicit-aosUrl error.
    }
  }
  return null;
}
