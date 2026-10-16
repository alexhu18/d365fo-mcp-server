export const traceD365foTool = {
  name: 'trace_d365fo',
  description: 'ETW trace of X++ and SQL time on the dev VM, instead of timer code. Fetch contract first.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['contract', 'start', 'stop', 'status', 'analyze', 'delete'] },
    },
    required: ['action'], // additional properties allowed; strict parameters come from contract
  },
};
