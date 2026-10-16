import type { Setting } from './settings.js';

export const TRACE_SETTINGS: Setting[] = [
  { path: 'trace.enabled', env: 'D365FO_TRACE_ENABLED', section: 'trace', tier: 'advanced', type: 'boolean',
    label: 'Enable ETW performance tracing',
    description: 'Publish the optional trace_d365fo tool: capture an ETW trace of X++ methods and SQL on this D365FO VM and analyse it, instead of adding timer code. Needs a Windows account allowed to run logman (Administrators or Performance Log Users).',
    default: false },
  { path: 'trace.outputDir', env: 'D365FO_TRACE_DIR', section: 'trace', tier: 'advanced', type: 'path',
    label: 'Folder for trace files',
    description: 'Where captures are written. A capture grows by tens of MB per second, so pick a drive with space. Left empty, the folder the agent proposes when it first needs one is remembered for this installation.' },
  { path: 'trace.maxSeconds', env: 'D365FO_TRACE_MAX_SECONDS', section: 'trace', tier: 'advanced', type: 'int',
    label: 'Longest capture in seconds (10–900)',
    description: 'A running capture is stopped after this many seconds even if nobody stops it.', default: 120 },
  { path: 'trace.maxSizeMB', env: 'D365FO_TRACE_MAX_SIZE_MB', section: 'trace', tier: 'advanced', type: 'int',
    label: 'Largest capture file in MB (100–20000)',
    description: 'logman stops the capture by itself when the file reaches this size.', default: 4096 },
];
