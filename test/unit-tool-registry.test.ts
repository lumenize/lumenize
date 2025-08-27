import { describe, it, expect, beforeEach } from 'vitest';
import { ToolRegistry, Tool } from '../src/tool-registry';

describe('ToolRegistry', () => {
  let registry: ToolRegistry;
  
  // Helper function to create test tools with minimal configuration
  const createTool = (overrides: Partial<Tool> = {}): Tool => ({
    name: 'test-tool',
    description: 'A test tool',
    inputSchema: {
      type: 'object',
      properties: { input: { type: 'string' } },
      required: ['input']
    },
    outputSchema: {
      type: 'object',
      properties: { output: { type: 'string' } },
      required: ['output']
    },
    handler: (args?: Record<string, any>) => ({ output: `processed: ${args?.input}` }),
    ...overrides
  });

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  describe('constructor', () => {
    it('should create an empty registry', () => {
      expect(registry.list()).toEqual([]);
    });
  });

  describe('validation', () => {
    it('should validate tool names correctly', () => {
      // Test valid names
      ['tool', 'tool-name', 'tool_name', 'tool123', 'a1-b2_c3'].forEach(name => {
        expect(() => registry.add(createTool({ name }))).not.toThrow();
        registry = new ToolRegistry(); // Reset for next test
      });

      // Test invalid names  
      ['Tool', 'tool.name', 'tool space', 'tool@name', 'tool/name', 'TOOL'].forEach(name => {
        expect(() => registry.add(createTool({ name }))).toThrow('Tool name must contain only lowercase letters, digits, hyphens (-), and underscores (_)');
      });
    });

    it('should validate required properties', () => {
      const validationTests = [
        // Missing name
        { modify: (tool: any) => delete tool.name, error: 'Tool name cannot be empty' },
        // Missing inputSchema
        { modify: (tool: any) => delete tool.inputSchema, error: 'Tool must have inputSchema property as an object' },
        // Invalid inputSchema type
        { modify: (tool: any) => tool.inputSchema = 'invalid', error: 'Tool must have inputSchema property as an object' },
        // Wrong inputSchema type
        { modify: (tool: any) => tool.inputSchema = { type: 'string', properties: {} }, error: "Tool inputSchema must have type 'object'" },
        // Missing outputSchema
        { modify: (tool: any) => delete tool.outputSchema, error: 'Tool must have outputSchema property as an object' },
        // Invalid outputSchema type
        { modify: (tool: any) => tool.outputSchema = 'invalid', error: 'Tool must have outputSchema property as an object' },
        // Wrong outputSchema type
        { modify: (tool: any) => tool.outputSchema = { type: 'array', properties: {} }, error: "Tool outputSchema must have type 'object'" },
        // Missing handler
        { modify: (tool: any) => delete tool.handler, error: 'Tool must have handler property as a function' },
        // Invalid handler type
        { modify: (tool: any) => tool.handler = 'not-a-function', error: 'Tool must have handler property as a function' }
      ];

      validationTests.forEach(({ modify, error }) => {
        const tool = createTool();
        modify(tool);
        expect(() => registry.add(tool)).toThrow(error);
      });
    });

    it('should reject duplicate tool names', () => {
      const tool = createTool();
      registry.add(tool);
      expect(() => registry.add(tool)).toThrow('Tool with name "test-tool" is already registered');
    });
  });

  describe('core functionality', () => {
    it('should add, list, and execute tools', () => {
      const tool1 = createTool({ name: 'tool1', handler: () => ({ result: 'tool1-output' }) });
      const tool2 = createTool({ name: 'tool2', handler: () => ({ result: 'tool2-output' }) });
      
      expect(registry.add(tool1)).toBe('tool1');
      expect(registry.add(tool2)).toBe('tool2');
      
      const list = registry.list();
      expect(list).toHaveLength(2);
      expect(list).toContain(tool1);
      expect(list).toContain(tool2);
      expect(registry.list()).not.toBe(list); // Returns new array each time
    });

    it('should execute different tool types', () => {
      // Math tool
      const mathTool = createTool({
        name: 'add',
        inputSchema: {
          type: 'object',
          properties: { a: { type: 'number' }, b: { type: 'number' } },
          required: ['a', 'b']
        },
        outputSchema: {
          type: 'object',
          properties: { sum: { type: 'number' } },
          required: ['sum']
        },
        handler: (args) => ({ sum: (args?.a ?? 0) + (args?.b ?? 0) })
      });

      // Sync tool (no longer async since we made execute() synchronous)
      const syncTool = createTool({
        name: 'sync-tool',
        inputSchema: { type: 'object', properties: { delay: { type: 'number' } } },
        outputSchema: { type: 'object', properties: { message: { type: 'string' } } },
        handler: (args) => {
          // Simulate work without async
          return { message: 'sync-complete' };
        }
      });

      // No-param tool
      const noParamTool = createTool({
        name: 'no-param',
        inputSchema: { type: 'object', properties: {} },
        outputSchema: { type: 'object', properties: { timestamp: { type: 'number' } } },
        handler: () => ({ timestamp: Date.now() })
      });

      registry.add(mathTool);
      registry.add(syncTool);
      registry.add(noParamTool);

      expect(registry.execute('add', { a: 5, b: 3 })).toEqual({ sum: 8 });
      expect(registry.execute('sync-tool', { delay: 5 })).toEqual({ message: 'sync-complete' });
      
      const result = registry.execute('no-param');
      expect(result).toHaveProperty('timestamp');
      expect(typeof result.timestamp).toBe('number');
    });
  });

  describe('error handling', () => {
    it('should handle execution errors', () => {
      // Non-existent tool
      expect(() => registry.execute('non-existent')).toThrow('Tool "non-existent" not found');

      // Parameter validation
      const strictTool = createTool({
        name: 'strict',
        inputSchema: {
          type: 'object',
          properties: {
            required_field: { type: 'string' },
            number_field: { type: 'number' }
          },
          required: ['required_field']
        },
        handler: () => ({ result: 'ok' })
      });
      registry.add(strictTool);

      expect(() => registry.execute('strict', {})).toThrow('Invalid params');
      expect(() => registry.execute('strict', { 
        required_field: 'valid',
        number_field: 'not-a-number'
      })).toThrow('Invalid params');

      // Handler errors
      const errorTool = createTool({
        name: 'error-tool',
        inputSchema: { type: 'object', properties: { error_type: { type: 'string' } } },
        handler: (args) => {
          if (args?.error_type === 'runtime') throw new Error('Runtime error from handler');
          if (args?.error_type === 'type') throw new TypeError('Type error from handler');
          return { result: 'no-error' };
        }
      });
      registry.add(errorTool);

      expect(() => registry.execute('error-tool', { error_type: 'runtime' }))
        .toThrow('Runtime error from handler');
      expect(() => registry.execute('error-tool', { error_type: 'type' }))
        .toThrow('Type error from handler');
      expect(registry.execute('error-tool', { error_type: 'none' }))
        .toEqual({ result: 'no-error' });
    });
  });

  describe('MCP compatibility', () => {
    it('should generate MCP-compatible tools list', () => {
      const tool1 = createTool({
        name: 'mcp-tool-1',
        description: 'First MCP tool',
        inputSchema: { type: 'object', properties: { input1: { type: 'string' } } },
        outputSchema: { type: 'object', properties: { output1: { type: 'string' } } },
        handler: () => ({ output1: 'result1' })
      });

      const tool2 = createTool({
        name: 'mcp-tool-2',
        inputSchema: { type: 'object', properties: { input2: { type: 'number' } } },
        outputSchema: { type: 'object', properties: { output2: { type: 'number' } } },
        handler: () => ({ output2: 42 })
      });
      // Remove description to test optional field
      delete (tool2 as any).description;

      registry.add(tool1);
      registry.add(tool2);

      const mcpResult = registry.listToolsForMCP();
      expect(mcpResult.tools).toHaveLength(2);
      
      const mcpTool1 = mcpResult.tools.find(t => t.name === 'mcp-tool-1')!;
      expect(mcpTool1.description).toBe('First MCP tool');
      expect(mcpTool1.inputSchema).toEqual(tool1.inputSchema);
      
      const mcpTool2 = mcpResult.tools.find(t => t.name === 'mcp-tool-2')!;
      expect(mcpTool2.description).toBeUndefined();
    });
  });

  describe('edge cases', () => {
    it('should handle complex schemas and annotations', () => {
      const complexTool = createTool({
        name: 'complex-tool',
        inputSchema: {
          type: 'object',
          properties: {
            nested: {
              type: 'object',
              properties: {
                value: { type: 'string' }
              },
              required: ['value']
            },
            optional: { type: 'boolean' }
          },
          required: ['nested']
        },
        annotations: {
          title: 'Complex Tool',
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        },
        handler: (args) => ({ processed: JSON.stringify(args) })
      });

      expect(() => registry.add(complexTool)).not.toThrow();
      expect(registry.list()[0].annotations).toEqual(complexTool.annotations);
    });

    it('should handle empty object parameters', () => {
      const emptyObjectTool = createTool({
        name: 'empty-object-tool',
        inputSchema: {
          type: 'object',
          properties: {},
          additionalProperties: false
        },
        outputSchema: {
          type: 'object',
          properties: { received: { type: 'string' } }
        },
        handler: (args) => ({ received: JSON.stringify(args ?? {}) })
      });

      registry.add(emptyObjectTool);
      
      expect(registry.execute('empty-object-tool', {})).toEqual({ received: '{}' });
      expect(registry.execute('empty-object-tool')).toEqual({ received: '{}' });
    });
  });
});
