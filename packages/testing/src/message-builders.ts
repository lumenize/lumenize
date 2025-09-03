/**
 * Message builder helpers to reduce duplication in tests
 */
export const MessageBuilders = {
  initialize: (id: number | string = 1, protocolVersion: string | null = 'DRAFT-2025-v2', clientInfo = { name: 'test-client', version: '1.0.0' }) => {
    const params: any = {
      capabilities: { roots: { listChanged: true }, sampling: {} },
      clientInfo
    };
    if (protocolVersion !== null) {
      params.protocolVersion = protocolVersion;
    }
    return JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'initialize',
      params
    });
  },

  toolsList: (id: number | string = 2) =>
    JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'tools/list',
      params: {}
    }),

  toolCall: (id: number | string = 3, name?: string, args: any = { a: 10, b: 4 }) => {
    const params: any = { arguments: args };
    if (name !== undefined) {
      params.name = name;
    }
    return JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params
    });
  },

  resourcesTemplatesList: (id: number | string = 4, params: any = {}) => {
    return JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'resources/templates/list',
      params
    });
  },

  notification: (method = 'notifications/initialized', params = {}) =>
    JSON.stringify({
      jsonrpc: '2.0',
      method,
      params
    }),

  envelope: (payload: any, type = 'mcp') =>
    JSON.stringify({ type, payload: typeof payload === 'string' ? JSON.parse(payload) : payload }),

  invalid: (overrides = {}) =>
    JSON.stringify({
      jsonrpc: '2.0',
      some: 'invalid',
      data: 'here',
      ...overrides
    })
};
