/**
 * restartAos without aosUrl reads the environment root the local AOS serves
 * from Infrastructure.HostUrl in AosService\WebRoot\web.config.
 */
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { localAosUrl } from '../../src/tools/sdlc/aosWebConfig.js';

let root: string | undefined;
afterEach(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); root = undefined; });

/** An AosService folder with PackagesLocalDirectory and, optionally, a WebRoot\web.config. */
function aosService(webConfig?: string): string {
  root = fs.mkdtempSync(join(tmpdir(), 'aos-webconfig-'));
  const packages = join(root, 'PackagesLocalDirectory');
  fs.mkdirSync(packages);
  if (webConfig !== undefined) {
    fs.mkdirSync(join(root, 'WebRoot'));
    fs.writeFileSync(join(root, 'WebRoot', 'web.config'), webConfig);
  }
  return packages;
}

describe('localAosUrl', () => {
  it('reads the environment root from Infrastructure.HostUrl', async () => {
    // As a cloud-hosted VM writes it: no trailing slash, value on its own line.
    const packages = aosService(`<appSettings>
    <add key="Infrastructure.HostUrl"
         value="https://vlt-dev-example-devaos.axcloud.dynamics.com" />
</appSettings>`);
    expect(await localAosUrl([packages])).toEqual({
      url: 'https://vlt-dev-example-devaos.axcloud.dynamics.com/',
      source: join(packages, '..', 'WebRoot', 'web.config'),
    });
  });

  it('reads the setting whatever the attribute order, and not a look-alike key', async () => {
    const packages = aosService(`<appSettings>
    <add key="Infrastructure.HostUrlSoap" value="https://soap.example.test/" />
    <add value="https://env.example.test" key="Infrastructure.HostUrl" />
</appSettings>`);
    expect((await localAosUrl([packages]))?.url).toBe('https://env.example.test/');
  });

  it('ignores a previous HostUrl kept in a comment above the live one', async () => {
    const packages = aosService(`<appSettings>
    <!-- <add key="Infrastructure.HostUrl" value="https://old.example.test/" /> -->
    <add key="Infrastructure.HostUrl" value="https://env.example.test/" />
</appSettings>`);
    expect((await localAosUrl([packages]))?.url).toBe('https://env.example.test/');
  });

  it('reduces a URL with a path to its environment root', async () => {
    const packages = aosService('<add key="Infrastructure.HostUrl" value="https://env.example.test/namespaces/AXSF/" />');
    expect((await localAosUrl([packages]))?.url).toBe('https://env.example.test/');
  });

  it('is null without a web.config — UDE has no local AOS', async () => {
    expect(await localAosUrl([aosService()])).toBeNull();
    expect(await localAosUrl([null, undefined])).toBeNull();
  });

  it('is null for a missing, empty or unusable HostUrl', async () => {
    for (const config of [
      '<add key="DataAccess.Database" value="AxDB" />',
      '<add key="Infrastructure.HostUrl" value="" />',
      '<add key="Infrastructure.HostUrl" value="not a url" />',
      '<add key="Infrastructure.HostUrl" value="https://user:pw@env.example.test/" />',
    ]) {
      expect(await localAosUrl([aosService(config)])).toBeNull();
      fs.rmSync(root!, { recursive: true, force: true });
    }
    root = undefined;
  });
});
