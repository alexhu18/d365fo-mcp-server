/**
 * readAppSetting reads `<appSettings>` the way .NET does, not the way the text
 * happens to be laid out. Each case below was a wrong answer from one of the
 * regex readers it replaces (web.config HostUrl, SysTestConsole DataAccess.*).
 */
import { describe, expect, it } from 'vitest';
import { readAppSetting } from '../../src/utils/appSettings';

const doc = (...rows: string[]) => ['<configuration>', '  <appSettings>', ...rows, '  </appSettings>', '</configuration>'].join('\n');

describe('readAppSetting', () => {
  it('ignores a commented-out entry that comes before the live one', () => {
    const xml = doc(
      '    <!-- <add key="Infrastructure.HostUrl" value="https://old.example.test/" /> -->',
      '    <add key="Infrastructure.HostUrl" value="https://live.example.test/" />',
    );
    expect(readAppSetting(xml, 'Infrastructure.HostUrl')).toBe('https://live.example.test/');
  });

  it('is undefined when the only entry is commented out', () => {
    const xml = doc('    <!--', '    <add key="DataAccess.DbServer" value="OLDSQL" />', '    -->');
    expect(readAppSetting(xml, 'DataAccess.DbServer')).toBeUndefined();
  });

  it('reads attributes in either order and either quote style', () => {
    expect(readAppSetting(doc('<add value="AxDB" key="DataAccess.Database" />'), 'DataAccess.Database')).toBe('AxDB');
    expect(readAppSetting(doc("<add key='DataAccess.Database' value='AxDB'/>"), 'DataAccess.Database')).toBe('AxDB');
    expect(readAppSetting(doc('<add\n  key="DataAccess.Database"\n  value="AxDB" />'), 'DataAccess.Database')).toBe('AxDB');
  });

  it('decodes entities', () => {
    expect(readAppSetting(doc('<add key="K" value="a&amp;b &lt;c&gt; &quot;d&quot; &#65;&#x42;" />'), 'K')).toBe('a&b <c> "d" AB');
  });

  it('keeps a ">" inside a quoted value', () => {
    expect(readAppSetting(doc('<add key="K" value="a>b" />'), 'K')).toBe('a>b');
  });

  it('matches the key case-insensitively and not a look-alike key', () => {
    const xml = doc('<add key="Infrastructure.HostUrlSoap" value="soap" />', '<add key="infrastructure.hosturl" value="env" />');
    expect(readAppSetting(xml, 'Infrastructure.HostUrl')).toBe('env');
  });

  it('reads only <appSettings> when the document has one', () => {
    const xml = [
      '<configuration>',
      '  <connectionStrings><add key="DataAccess.DbServer" value="wrong" /></connectionStrings>',
      '  <appSettings><add key="DataAccess.DbServer" value="right" /></appSettings>',
      '</configuration>',
    ].join('\n');
    expect(readAppSetting(xml, 'DataAccess.DbServer')).toBe('right');
  });

  it('takes the last value of a key added twice', () => {
    expect(readAppSetting(doc('<add key="K" value="first" />', '<add key="K" value="second" />'), 'K')).toBe('second');
  });

  it('reads a fragment with no <appSettings> wrapper', () => {
    expect(readAppSetting('<add key="K" value="v" />', 'K')).toBe('v');
  });
});
