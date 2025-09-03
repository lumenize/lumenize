import { expect } from 'vitest';

/**
 * Test expectation helpers for common response validation
 */
export const ExpectedResponses = {
  initialize: (data: any, id: number | string = 1) => {
    expect(data.jsonrpc).toBe('2.0');
    expect(data.id).toBe(id);
    expect(data.result).toBeDefined();
    expect(data.result.serverInfo.name).toBe('lumenize');
    expect(data.result.capabilities).toBeDefined();
    expect(data.result.protocolVersion).toBe('DRAFT-2025-v2');
  },

  error: (data: any, code: number, id?: number | string) => {
    expect(data.jsonrpc).toBe('2.0');
    if (id !== undefined) expect(data.id).toBe(id);
    expect(data.error).toBeDefined();
    expect(data.error.code).toBe(code);
  },

  toolsList: (data: any, id: number | string = 2) => {
    expect(data.jsonrpc).toBe('2.0');
    expect(data.id).toBe(id);
    expect(data.result).toBeDefined();
    expect(data.result.tools).toBeDefined();
    expect(Array.isArray(data.result.tools)).toBe(true);
  },

  toolCall: (data: any, id: number | string = 3) => {
    expect(data.jsonrpc).toBe('2.0');
    expect(data.id).toBe(id);
    expect(data.result).toBeDefined();
    expect(data.result.structuredContent).toBeDefined();
  },

  resourcesTemplatesList: (data: any, id: number | string = 4) => {
    expect(data.jsonrpc).toBe('2.0');
    expect(data.id).toBe(id);
    expect(data.result).toBeDefined();
    expect(data.result.resourceTemplates).toBeDefined();
    expect(Array.isArray(data.result.resourceTemplates)).toBe(true);
  },

  envelope: (data: any, type = 'mcp') => {
    expect(data.type).toBe(type);
    expect(data.payload).toBeDefined();
    expect(data.payload.jsonrpc).toBe('2.0');
  }
};
