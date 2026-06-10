import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  existsSyncMock,
  readFileSyncMock,
  bridgeRefreshProviderMock,
} = vi.hoisted(() => ({
  existsSyncMock: vi.fn(),
  readFileSyncMock: vi.fn(),
  bridgeRefreshProviderMock: vi.fn(async () => undefined),
}));

vi.mock('fs', () => ({
  default: {
    existsSync: existsSyncMock,
    readFileSync: readFileSyncMock,
  },
  existsSync: existsSyncMock,
  readFileSync: readFileSyncMock,
}));

vi.mock('../../src/bridge/index.js', () => ({
  bridgeRefreshProvider: bridgeRefreshProviderMock,
}));

import { updateSymbolIndexTool } from '../../src/tools/updateSymbolIndex';
import type { XppServerContext } from '../../src/types/context';

function createContext(): XppServerContext {
  return {
    symbolIndex: {
      removeSymbolsByFile: vi.fn(() => ({ deletedCount: 0, objectNames: [] })),
      removeLabelsByFile: vi.fn(() => 0),
      bulkAddLabels: vi.fn(),
      db: {
        prepare: vi.fn(() => ({ run: vi.fn(() => ({ changes: 0 })) })),
        transaction: vi.fn((fn: any) => fn),
      },
      addSymbol: vi.fn(),
    } as any,
    parser: {} as any,
    cache: {
      delete: vi.fn(async () => undefined),
      deletePattern: vi.fn(async () => undefined),
      generateClassKey: vi.fn((name: string) => `xpp:class:${name}`),
      generateTableKey: vi.fn((name: string) => `xpp:table:${name}`),
    } as any,
    workspaceScanner: {} as any,
    hybridSearch: {} as any,
    bridge: {} as any,
  } as XppServerContext;
}

describe('update_symbol_index label file reconciliation', () => {
  let context: XppServerContext;

  beforeEach(() => {
    context = createContext();
    vi.clearAllMocks();
  });

  it('reconciles a label file by removing stale rows and inserting current labels', async () => {
    const filePath = 'K:\\PackagesLocalDirectory\\MyPackage\\MyModel\\AxLabelFile\\LabelResources\\en-US\\MyLabels.en-US.label.txt';

    existsSyncMock.mockReturnValue(true);
    readFileSyncMock.mockReturnValue('Existing=Existing text\n');
    (context.symbolIndex.removeLabelsByFile as any).mockReturnValue(2);

    const result = await updateSymbolIndexTool({ filePath }, context);

    expect(context.symbolIndex.removeLabelsByFile).toHaveBeenCalledWith(filePath);
    expect(context.symbolIndex.bulkAddLabels).toHaveBeenCalledTimes(1);

    const insertedRows = (context.symbolIndex.bulkAddLabels as any).mock.calls[0][0];
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0]).toMatchObject({
      labelId: 'Existing',
      labelFileId: 'MyLabels',
      model: 'MyModel',
      language: 'en-US',
      text: 'Existing text',
      filePath,
    });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('Removed: 2');
    expect(result.content[0].text).toContain('Inserted: 1 label');
  });

  it('cleans labels when a label file is deleted', async () => {
    const filePath = 'K:\\PackagesLocalDirectory\\MyPackage\\MyModel\\AxLabelFile\\LabelResources\\en-US\\MyLabels.en-US.label.txt';

    existsSyncMock.mockReturnValue(false);
    (context.symbolIndex.removeLabelsByFile as any).mockReturnValue(3);

    const result = await updateSymbolIndexTool({ filePath }, context);

    expect(context.symbolIndex.removeLabelsByFile).toHaveBeenCalledWith(filePath);
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('3 label(s)');
  });
});
