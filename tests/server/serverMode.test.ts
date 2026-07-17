/**
 * Server mode gating tests.
 *
 * isToolAllowedInMode is the single predicate shared by the ListTools filter
 * (mcpServer) and the runtime call gate (toolHandler). These tests pin the
 * contract: ALWAYS_TOOLS bypass the LOCAL_TOOLS partition in EVERY mode, so a
 * tool advertised by the list filter can never be refused at call time.
 */

import { describe, it, expect } from 'vitest';
import {
  LOCAL_TOOLS,
  ALWAYS_TOOLS,
  isToolAllowedInMode,
  type ServerMode,
} from '../../src/server/serverMode';

const MODES: ServerMode[] = ['full', 'read-only', 'write-only'];

describe('isToolAllowedInMode', () => {
  it('allows everything in full mode', () => {
    expect(isToolAllowedInMode('full', 'search')).toBe(true);
    expect(isToolAllowedInMode('full', 'undo_last_modification')).toBe(true);
    expect(isToolAllowedInMode('full', 'get_object_info')).toBe(true);
  });

  it('allows ALWAYS_TOOLS in every mode (regression: write-only refused get_object_info)', () => {
    for (const mode of MODES) {
      for (const tool of ALWAYS_TOOLS) {
        expect(isToolAllowedInMode(mode, tool), `${tool} in ${mode}`).toBe(true);
      }
    }
  });

  it('write-only allows get_object_info (the originally reported defect)', () => {
    expect(isToolAllowedInMode('write-only', 'get_object_info')).toBe(true);
    expect(isToolAllowedInMode('write-only', 'labels')).toBe(true);
    expect(isToolAllowedInMode('write-only', 'd365fo_file')).toBe(true);
  });

  it('write-only allows local tools and blocks search/analysis tools', () => {
    for (const tool of LOCAL_TOOLS) {
      expect(isToolAllowedInMode('write-only', tool), `${tool} in write-only`).toBe(true);
    }
    expect(isToolAllowedInMode('write-only', 'search')).toBe(false);
    expect(isToolAllowedInMode('write-only', 'analyze_code')).toBe(false);
  });

  it('read-only blocks local tools and allows the rest', () => {
    for (const tool of LOCAL_TOOLS) {
      expect(isToolAllowedInMode('read-only', tool), `${tool} in read-only`).toBe(false);
    }
    expect(isToolAllowedInMode('read-only', 'search')).toBe(true);
    expect(isToolAllowedInMode('read-only', 'analyze_code')).toBe(true);
  });
});
