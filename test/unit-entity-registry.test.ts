import { describe, it, expect, beforeEach } from 'vitest';
import { EntityUriRouter, UriTemplateType } from '../src/entity-uri-router';
// @ts-ignore - Not sure why TS can't find this
import { 
  MessageBuilders, 
  ExpectedResponses, 
  runTestWithLumenize
} from './test-utils';

describe('Entity Registry Tests', () => {
  let router: EntityUriRouter;

  beforeEach(() => {
    router = new EntityUriRouter();
  });

  describe('Entity Registry Template', () => {
    it('should generate entity registry template correctly', () => {
      const template = router.getEntityRegistryResourceTemplate(
        'lumenize', 'default', 'default', 'default'
      );

      expect(template.name).toBe('Entity Type Registry');
      expect(template.uriTemplate).toBe('https://lumenize/universe/default/galaxy/default/star/default/entity-types');
      expect(template.description).toContain('Complete registry of all entity type definitions');
      expect(template.mimeType).toBe('application/json');
    });

    it('should parse entity registry URIs correctly', () => {
      const uri = 'https://lumenize/universe/default/galaxy/default/star/default/entity-types';
      const parsed = router.parseEntityUri(uri);

      expect(parsed.type).toBe(UriTemplateType.ENTITY_REGISTRY);
      expect(parsed.params).toEqual({
        domain: 'lumenize',
        universe: 'default',
        galaxy: 'default',
        star: 'default'
      });
    });

    it('should build entity registry URIs correctly', () => {
      const uri = router.buildEntityUri(UriTemplateType.ENTITY_REGISTRY, {
        domain: 'lumenize',
        universe: 'default',
        galaxy: 'default',
        star: 'default'
      });

      expect(uri).toBe('https://lumenize/universe/default/galaxy/default/star/default/entity-types');
    });

    it('should validate entity registry URI components', () => {
      expect(() => {
        router.buildEntityUri(UriTemplateType.ENTITY_REGISTRY, {
          domain: 'Invalid-Domain!',
          universe: 'default',
          galaxy: 'default',
          star: 'default'
        });
      }).toThrow('Invalid domain');

      expect(() => {
        router.buildEntityUri(UriTemplateType.ENTITY_REGISTRY, {
          domain: 'lumenize',
          universe: 'Invalid Universe',
          galaxy: 'default',
          star: 'default'
        });
      }).toThrow('Invalid universe');
    });
  });

  describe('Entity Registry Resource Read', () => {
    it('should read entity registry via MCP resources/read', async () => {
      await runTestWithLumenize(async (instance, mock, state) => {
        // Add some entity types first
        const addEntityType1 = MessageBuilders.toolCall(1, 'add-entity-type', {
          name: 'test-entity-1',
          version: 1,
          jsonSchema: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              value: { type: 'number' }
            },
            required: ['name', 'value']
          },
          description: 'Test entity 1'
        });
        await instance.onMessage(mock.connection, addEntityType1);

        const addEntityType2 = MessageBuilders.toolCall(2, 'add-entity-type', {
          name: 'test-entity-2',
          version: 2,
          jsonSchema: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              active: { type: 'boolean' }
            },
            required: ['title', 'active']
          },
          description: 'Test entity 2'
        });
        await instance.onMessage(mock.connection, addEntityType2);

        mock.clearMessages();

        // Read entity registry using the generic resources/read endpoint
        // This simulates how MCP clients would read resources
        const readMessage = JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          method: 'resources/read',
          params: {
            uri: 'https://lumenize/universe/default/galaxy/default/star/default/entity-types'
          }
        });
        await instance.onMessage(mock.connection, readMessage);

        const sentMessage = mock.getLastMessage();
        expect(sentMessage).toBeDefined();

        const data = JSON.parse(sentMessage);
        expect(data.jsonrpc).toBe('2.0');
        expect(data.id).toBe(3);
        expect(data.result).toBeDefined();

        // Verify registry contents
        expect(data.result.contents).toHaveLength(1);
        const content = data.result.contents[0];
        expect(content.uri).toBe('https://lumenize/universe/default/galaxy/default/star/default/entity-types');
        expect(content.mimeType).toBe('application/json');

        const entityTypes = JSON.parse(content.text);
        expect(Array.isArray(entityTypes)).toBe(true);
        expect(entityTypes).toHaveLength(2);

        const entity1 = entityTypes.find((et: any) => et.name === 'test-entity-1');
        const entity2 = entityTypes.find((et: any) => et.name === 'test-entity-2');

        expect(entity1).toBeDefined();
        expect(entity1.version).toBe(1);
        expect(entity1.jsonSchema).toBeDefined();
        expect(entity1.jsonSchema.properties.name.type).toBe('string');

        expect(entity2).toBeDefined();
        expect(entity2.version).toBe(2);
        expect(entity2.jsonSchema).toBeDefined();
        expect(entity2.jsonSchema.properties.title.type).toBe('string');
      });
    });

    it('should read empty entity registry when no entity types exist', async () => {
      await runTestWithLumenize(async (instance, mock, state) => {
        // Read entity registry without adding any entity types
        const readMessage = JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'resources/read',
          params: {
            uri: 'https://lumenize/universe/default/galaxy/default/star/default/entity-types'
          }
        });
        await instance.onMessage(mock.connection, readMessage);

        const sentMessage = mock.getLastMessage();
        expect(sentMessage).toBeDefined();

        const data = JSON.parse(sentMessage);
        expect(data.jsonrpc).toBe('2.0');
        expect(data.id).toBe(1);
        expect(data.result).toBeDefined();

        // Verify empty registry contents
        expect(data.result.contents).toHaveLength(1);
        const content = data.result.contents[0];
        expect(content.uri).toBe('https://lumenize/universe/default/galaxy/default/star/default/entity-types');
        expect(content.mimeType).toBe('application/json');

        const entityTypes = JSON.parse(content.text);
        expect(Array.isArray(entityTypes)).toBe(true);
        expect(entityTypes).toHaveLength(0);
      });
    });
  });

  describe('Entity Registry HTTP GET', () => {
    it('should parse entity registry URIs for HTTP requests', () => {
      // Test that entity registry URIs can be parsed (HTTP handling is integration tested elsewhere)
      const uri = 'https://lumenize/universe/default/galaxy/default/star/default/entity-types';
      const parsed = router.parseEntityUri(uri);
      
      expect(parsed.type).toBe(UriTemplateType.ENTITY_REGISTRY);
      expect(parsed.params).toEqual({
        domain: 'lumenize',
        universe: 'default', 
        galaxy: 'default',
        star: 'default'
      });
    });
  });

  describe('Entity Registry in Resource Templates', () => {
    it('should include entity registry in resource templates list', async () => {
      await runTestWithLumenize(async (instance, mock, state) => {
        // Get resource templates
        const templatesMessage = MessageBuilders.resourcesTemplatesList(1, {});
        await instance.onMessage(mock.connection, templatesMessage);

        const sentMessage = mock.getLastMessage();
        expect(sentMessage).toBeDefined();

        const data = JSON.parse(sentMessage);
        ExpectedResponses.resourcesTemplatesList(data, 1);

        // Should have all 5 generic templates even with no entity types
        expect(data.result.resourceTemplates).toHaveLength(5);
        const registryTemplate = data.result.resourceTemplates.find((t: any) => t.name === 'Entity Type Registry');
        expect(registryTemplate).toBeDefined();
        expect(registryTemplate.name).toBe('Entity Type Registry');
        expect(registryTemplate.uriTemplate).toBe('https://lumenize/universe/default/galaxy/default/star/default/entity-types');
        expect(registryTemplate.mimeType).toBe('application/json');
      });
    });
  });

  describe('Entity Type Creation', () => {
    it('should create new entity types successfully', async () => {
      await runTestWithLumenize(async (instance, mock, state) => {
        // Clear any previous state
        mock.clearMessages();

        // === Create First Entity Type ===
        const entityTypeData1 = {
          name: 'new-test-entity-1',
          version: 1,
          jsonSchema: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              value: { type: 'number' }
            },
            required: ['name', 'value']
          },
          description: 'First test entity'
        };

        const createMessage1 = MessageBuilders.toolCall(1, 'add-entity-type', entityTypeData1);
        await instance.onMessage(mock.connection, createMessage1);

        // Verify successful creation response
        const responseMessage1 = mock.getLastMessage();
        expect(responseMessage1).toBeDefined();

        const responseData1 = JSON.parse(responseMessage1);
        expect(responseData1.jsonrpc).toBe('2.0');
        expect(responseData1.id).toBe(1);
        expect(responseData1.result).toBeDefined();
        expect(responseData1.result.structuredContent.success).toBe(true);

        // === Create Second Entity Type ===
        const entityTypeData2 = {
          name: 'new-test-entity-2',
          version: 1,
          jsonSchema: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              active: { type: 'boolean' }
            },
            required: ['title', 'active']
          },
          description: 'Second test entity'
        };

        const createMessage2 = MessageBuilders.toolCall(2, 'add-entity-type', entityTypeData2);
        await instance.onMessage(mock.connection, createMessage2);

        // Verify successful creation response
        const responseMessage2 = mock.getLastMessage();
        expect(responseMessage2).toBeDefined();

        const responseData2 = JSON.parse(responseMessage2);
        expect(responseData2.jsonrpc).toBe('2.0');
        expect(responseData2.id).toBe(2);
        expect(responseData2.result).toBeDefined();
        expect(responseData2.result.structuredContent.success).toBe(true);

        // === Read Entity Registry ===
        mock.clearMessages();

        const readMessage = JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          method: 'resources/read',
          params: {
            uri: 'https://lumenize/universe/default/galaxy/default/star/default/entity-types'
          }
        });
        await instance.onMessage(mock.connection, readMessage);

        const sentMessage = mock.getLastMessage();
        expect(sentMessage).toBeDefined();

        const data = JSON.parse(sentMessage);
        expect(data.jsonrpc).toBe('2.0');
        expect(data.id).toBe(3);
        expect(data.result).toBeDefined();

        // Verify registry contents
        expect(data.result.contents).toHaveLength(1);
        const content = data.result.contents[0];
        expect(content.uri).toBe('https://lumenize/universe/default/galaxy/default/star/default/entity-types');
        expect(content.mimeType).toBe('application/json');

        const registryData = JSON.parse(content.text);
        expect(Array.isArray(registryData)).toBe(true);
        expect(registryData).toHaveLength(2);
        
        const entity1 = registryData.find((et: any) => et.name === 'new-test-entity-1');
        const entity2 = registryData.find((et: any) => et.name === 'new-test-entity-2');
        
        expect(entity1).toBeDefined();
        expect(entity1.version).toBe(1);
        expect(entity1.description).toBe('First test entity');
        
        expect(entity2).toBeDefined();
        expect(entity2.version).toBe(1);
        expect(entity2.description).toBe('Second test entity');
      });
    });

    it('should reject duplicate entity type creation with error', async () => {
      await runTestWithLumenize(async (instance, mock, state) => {
        // Clear any previous state
        mock.clearMessages();

        // === Create Initial Entity Type ===
        const entityTypeData = {
          name: 'duplicate-test-entity',
          version: 1,
          jsonSchema: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              value: { type: 'number' }
            },
            required: ['name']
          },
          description: 'First version of test entity'
        };

        const createMessage1 = MessageBuilders.toolCall(1, 'add-entity-type', entityTypeData);
        await instance.onMessage(mock.connection, createMessage1);
        
        const result1 = mock.getMessageById(1);
        expect(result1.error).toBeUndefined();
        expect(result1.result.structuredContent.success).toBe(true);

        // === Attempt to Create Duplicate Entity Type ===
        const duplicateMessage = MessageBuilders.toolCall(2, 'add-entity-type', {
          ...entityTypeData,
          description: 'Attempting to create duplicate' // Same name & version, different description
        });

        await instance.onMessage(mock.connection, duplicateMessage);
        
        const result2 = mock.getMessageById(2);
        
        // Should receive an error, not success
        expect(result2.error).toBeDefined();
        expect(result2.error.code).toBe(-32603); // InternalError
        expect(result2.error.message).toContain('already exists');
        expect(result2.error.message).toContain('duplicate-test-entity');
        expect(result2.error.message).toContain("and version '1'"); // Actual error message format with quotes
        
        // Verify the error is properly formatted
        expect(result2.result).toBeUndefined(); // No result when there's an error
      });
    });
  });
});
