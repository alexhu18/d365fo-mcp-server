/**
 * labels(action="update") changes what the call states, and nothing else (#1105).
 *
 * Update is create with overwriteExisting. Without a `languages` scope it writes
 * every existing language folder, and a folder with no supplied translation used
 * to get the en-US (last-resort) text — so fixing an English typo replaced the
 * Italian and German translations with English. Every written label also had its
 * developer comment replaced by the default description (project name or
 * labelFileId), the supplied language included.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createLabelsBulk } from '../../src/tools/write/createLabel';
import { labelsTool } from '../../src/tools/labels';
import type { XppServerContext } from '../../src/types/context';

vi.mock('../../src/utils/configManager', () => ({
  getConfigManager: () => ({
    ensureLoaded: async () => {},
    getProjectPath: async () => null,
    getDevEnvironmentType: async () => 'traditional',
    getWriteAnchorModel: () => 'LocaleModel',
    getToolProjectSwitch: () => null,
  }),
}));

describe('labels(action="update") on an existing label', () => {
  let root: string;
  let resources: string;
  const context = () => ({ symbolIndex: { bulkAddLabels: vi.fn() } } as unknown as XppServerContext);

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'label-update-'));
    resources = path.join(root, 'LocalePackage', 'LocaleModel', 'AxLabelFile', 'LabelResources');
    await seed('en-US', 'Greeting=Helo\r\n ;Greeting shown on the start page\r\nOther=Keep me\r\n');
    await seed('it', 'Greeting=Ciao\r\n ;Saluto della pagina iniziale\r\n');
    await seed('de', 'Greeting=Hallo\r\n ;Begrüßung auf der Startseite\r\n');
  });

  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  const file = (language: string) => path.join(resources, language, `LocaleModel.${language}.label.txt`);
  const read = (language: string) => fs.readFile(file(language), 'utf8');

  async function seed(language: string, body: string) {
    await fs.mkdir(path.dirname(file(language)), { recursive: true });
    await fs.writeFile(file(language), `\uFEFF${body}`);
  }

  async function update(translations: Array<{ language: string; text: string; comment?: string }>, extra: Record<string, unknown> = {}) {
    const result = await labelsTool({
      method: 'tools/call',
      params: { name: 'labels', arguments: {
        action: 'update', labelId: 'Greeting', labelFileId: 'LocaleModel', model: 'LocaleModel',
        packageName: 'LocalePackage', packagePath: root, addToProject: false, translations, ...extra,
      } },
    } as any, context());
    expect(result.isError).toBeFalsy();
    return String(result.content[0].text);
  }

  it('fixes the English text and keeps the other translations and every comment', async () => {
    const reply = await update([{ language: 'en-US', text: 'Hello' }]);
    expect(await read('en-US')).toContain('Greeting=Hello\r\n ;Greeting shown on the start page\r\n');
    expect(await read('en-US')).toContain('Other=Keep me');
    expect(await read('it')).toContain('Greeting=Ciao\r\n ;Saluto della pagina iniziale\r\n');
    expect(await read('de')).toContain('Greeting=Hallo\r\n ;Begrüßung auf der Startseite\r\n');
    expect(reply).toContain('✔ en-US  → Hello');
    expect(reply).toContain('⚠ Kept existing text in de ("Hallo"), it ("Ciao") — no translation supplied for them; pass theirs to change them.');
    expect(reply).not.toMatch(/Translation fallback/);
  });

  it('lets a fallback copy of the old English follow the update', async () => {
    // An earlier create with only en-US seeded `it` with the English text.
    await seed('it', 'Greeting=Helo\r\n ;Copied\r\n');
    const reply = await update([{ language: 'en-US', text: 'Hello' }]);
    expect(await read('it')).toContain('Greeting=Hello\r\n ;Copied\r\n');
    expect(await read('de')).toContain('Greeting=Hallo');
    expect(reply).toContain('⚠ Translation fallback (en-US): en-US text written to it');
    expect(reply).toContain('⚠ Kept existing text in de ("Hallo") — no translation supplied for it; pass one to change it.');
  });

  it('writes a supplied translation, including through a parent locale, and keeps its comment', async () => {
    await seed('it-IT', 'Greeting=Ciao IT\r\n ;Commento\r\n');
    await update([{ language: 'en-US', text: 'Hello' }, { language: 'it', text: 'Salve' }]);
    expect(await read('it')).toContain('Greeting=Salve\r\n ;Saluto della pagina iniziale\r\n');
    expect(await read('it-IT')).toContain('Greeting=Salve\r\n ;Commento\r\n');
    expect(await read('de')).toContain('Greeting=Hallo');
  });

  it('replaces a comment only when the call states one', async () => {
    await update([{ language: 'en-US', text: 'Hello', comment: 'New English comment' }, { language: 'de', text: 'Guten Tag' }]);
    expect(await read('en-US')).toContain('Greeting=Hello\r\n ;New English comment\r\n');
    expect(await read('de')).toContain('Greeting=Guten Tag\r\n ;Begrüßung auf der Startseite\r\n');

    await update([{ language: 'en-US', text: 'Hello' }, { language: 'de', text: 'Hallo' }], { defaultComment: 'Shared comment' });
    expect(await read('en-US')).toContain(' ;Shared comment\r\n');
    expect(await read('de')).toContain(' ;Shared comment\r\n');
    expect(await read('it')).toContain('Greeting=Ciao\r\n ;Saluto della pagina iniziale\r\n');

    await update([{ language: 'en-US', text: 'Hello' }], { description: 'Described' });
    expect(await read('en-US')).toContain(' ;Described\r\n');
  });

  it('still creates the label in a folder that lacks it, with the usual fallback', async () => {
    await seed('fr', 'Other=Autre\r\n');
    const reply = await update([{ language: 'en-US', text: 'Hello' }]);
    expect(await read('fr')).toContain('Greeting=Hello');
    expect(await read('fr')).toContain('Other=Autre');
    expect(reply).toContain('⚠ Translation fallback (en-US): en-US text written to fr');
    expect(await read('it')).toContain('Greeting=Ciao');
  });

  it('keeps the same rule inside an explicit languages scope', async () => {
    const reply = await update([{ language: 'en-US', text: 'Hello' }], { languages: ['en-US', 'it'] });
    expect(await read('it')).toContain('Greeting=Ciao');
    expect(reply).toContain('⚠ Kept existing text in it ("Ciao")');
  });

  it('recognises a fallback copy even when the languages scope leaves en-US out', async () => {
    await seed('it', 'Greeting=Helo\r\n ;Copied\r\n');
    await update([{ language: 'en-US', text: 'Hello' }], { languages: ['it'] });
    expect(await read('it')).toContain('Greeting=Hello\r\n ;Copied\r\n');
    expect(await read('en-US')).toContain('Greeting=Helo');
  });

  it('never takes en-US for a copy of another language that happens to read the same', async () => {
    // Status, Name, Filter… are the same word in English and German. Without en-US in the
    // call the fallback source is `de`, and en-US used to be judged its "copy".
    await seed('en-US', 'Greeting=Status\r\n ;English comment\r\n');
    await seed('de', 'Greeting=Status\r\n');
    await update([{ language: 'de', text: 'Zustand' }]);
    expect(await read('de')).toContain('Greeting=Zustand');
    expect(await read('en-US')).toContain('Greeting=Status\r\n ;English comment\r\n');
    expect(await read('it')).toContain('Greeting=Ciao');
  });

  it('adds no comment the call did not state to a label that had none', async () => {
    await seed('en-US', 'Greeting=Helo\r\nOther=Keep me\r\n');
    await update([{ language: 'en-US', text: 'Hello' }]);
    expect(await read('en-US')).toContain('Greeting=Hello\r\nOther=Keep me');
  });

  it('takes the text and the comment from the same entry when a locale is given twice', async () => {
    await update([
      { language: 'en_US', text: 'First', comment: 'first comment' },
      { language: 'en-US', text: 'Second', comment: 'second comment' },
    ]);
    expect(await read('en-US')).toContain('Greeting=Second\r\n ;second comment\r\n');
  });

  it('writes a folder listed twice in the languages scope once', async () => {
    const reply = await update([{ language: 'en-US', text: 'Hello' }], { languages: ['en-US', 'en_US'] });
    expect(reply.match(/✔ en-US/g)).toHaveLength(1);
  });

  it('names a folder listed twice by its FIRST spelling, as translations do', async () => {
    await update([{ language: 'en-US', text: 'Hello' }], { languages: ['en-US', 'fr-FR', 'FR-fr'] });
    const folders = await fs.readdir(resources);
    expect(folders).toContain('fr-FR');
    expect(folders).not.toContain('FR-fr');
  });

  it('says the label was left unchanged when every targeted folder kept its text', async () => {
    const reply = await update([{ language: 'en-US', text: 'Hello' }], { languages: ['it'] });
    expect(reply).toContain('left unchanged');
    expect(reply).not.toContain('updated successfully');
    expect(await read('it')).toContain('Greeting=Ciao');
    expect(await read('en-US')).toContain('Greeting=Helo');
  });

  it('forwards the kept line in bulk mode', async () => {
    const result = await createLabelsBulk(
      [{ labelId: 'Greeting', translations: [{ language: 'en-US', text: 'Hello' }] }],
      {
        labelFileId: 'LocaleModel', model: 'LocaleModel', packageName: 'LocalePackage', packagePath: root,
        addToProject: false, overwriteExisting: true,
      },
      context(),
    );
    expect(result.isError).toBe(false);
    expect(result.content[0].text).toMatch(/🟢 Greeting: .*\n {4}⚠ Kept existing text in de \("Hallo"\), it \("Ciao"\)/);
    expect(await read('it')).toContain('Greeting=Ciao');
  });

  it('leaves create alone: a create still skips the existing label in every folder', async () => {
    const result = await labelsTool({
      method: 'tools/call',
      params: { name: 'labels', arguments: {
        action: 'create', labelId: 'Greeting', labelFileId: 'LocaleModel', model: 'LocaleModel',
        packageName: 'LocalePackage', packagePath: root, addToProject: false,
        translations: [{ language: 'en-US', text: 'Hello' }],
      } },
    } as any, context());
    expect(String(result.content[0].text)).toContain('already exists in all languages');
    expect(await read('en-US')).toContain('Greeting=Helo');
  });
});
