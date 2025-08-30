import { EntityUriRouter, UriTemplateType, URI_TEMPLATES } from '../src/entity-uri-router';
import { InvalidUriError } from '../src/errors';
import { describe, expect, test } from 'vitest';

describe('EntityUriRouter', () => {
  const router = new EntityUriRouter();

  // Test URIs for each template type (now without entity type in path)
  const testUris = {
    currentEntity: 'https://example.com/universe/test-universe/galaxy/test-galaxy/star/test-star/entity/user123',
    patchSubscription: 'https://example.com/universe/test-universe/galaxy/test-galaxy/star/test-star/entity/user123/patch',
    patchRead: 'https://example.com/universe/test-universe/galaxy/test-galaxy/star/test-star/entity/user123/patch/2024-01-01T10:00:00Z',
    historical: 'https://example.com/universe/test-universe/galaxy/test-galaxy/star/test-star/entity/user123/at/2024-01-01T10:00:00Z'
  };

  describe('Template 1: Current Entity', () => {
    test('should parse current entity URI correctly', () => {
      const result = router.parseEntityUri(testUris.currentEntity);
      
      expect(result.type).toBe(UriTemplateType.CURRENT_ENTITY);
      expect(result.params).toEqual({
        domain: 'example.com',
        universe: 'test-universe',
        galaxy: 'test-galaxy',
        star: 'test-star',
        id: 'user123'
      });
    });
  });

  describe('Template 2: Patch Subscription', () => {
    test('should parse patch subscription URI correctly', () => {
      const result = router.parseEntityUri(testUris.patchSubscription);
      
      expect(result.type).toBe(UriTemplateType.PATCH_SUBSCRIPTION);
      expect(result.params).toEqual({
        domain: 'example.com',
        universe: 'test-universe',
        galaxy: 'test-galaxy',
        star: 'test-star',
        id: 'user123'
      });
    });
  });

  describe('Template 3: Patch Read', () => {
    test('should parse patch read URI correctly', () => {
      const result = router.parseEntityUri(testUris.patchRead);
      
      expect(result.type).toBe(UriTemplateType.PATCH_READ);
      expect(result.params).toEqual({
        domain: 'example.com',
        universe: 'test-universe',
        galaxy: 'test-galaxy',
        star: 'test-star',
        id: 'user123',
        baseline: '2024-01-01T10:00:00Z'
      });
    });
  });

  describe('Template 4: Historical', () => {
    test('should parse historical URI correctly', () => {
      const result = router.parseEntityUri(testUris.historical);
      
      expect(result.type).toBe(UriTemplateType.HISTORICAL);
      expect(result.params).toEqual({
        domain: 'example.com',
        universe: 'test-universe',
        galaxy: 'test-galaxy',
        star: 'test-star',
        id: 'user123',
        timestamp: '2024-01-01T10:00:00Z'
      });
    });
  });

  describe('Format Validation', () => {
    test('should accept all valid formatted URI components', () => {
      // Test comprehensive valid format with all allowed characters
      const validUri = 'https://api.example.com/universe/test-env_2/galaxy/cluster-01/star/worker_node_1/entity/order-123_test';
      const result = router.parseEntityUri(validUri);
      
      expect(result.params).toEqual({
        domain: 'api.example.com',
        universe: 'test-env_2',
        galaxy: 'cluster-01',
        star: 'worker_node_1',
        id: 'order-123_test'
      });
    });

    test('should handle backwards compatibility with previously encoded URIs', () => {
      // Test with characters that were previously encoded but are now valid
      const encodedUri = 'https://example.com/universe/test%2Duniverse/galaxy/test%2Dgalaxy/star/test%2Dstar/entity/user%2D123';
      const result = router.parseEntityUri(encodedUri);
      
      expect(result.params).toEqual({
        domain: 'example.com',
        universe: 'test-universe',
        galaxy: 'test-galaxy',
        star: 'test-star',
        id: 'user-123'
      });
    });

    test('should reject invalid characters in system components', () => {
      // Invalid: spaces and special characters in universe/galaxy/star (must be lowercase + numbers + hyphens + underscores)
      expect(() => router.parseEntityUri('https://example.com/universe/Test Universe/galaxy/test-galaxy/star/test-star/entity/user123')).toThrow(InvalidUriError);
      expect(() => router.parseEntityUri('https://example.com/universe/test-universe/galaxy/test@galaxy/star/test-star/entity/user123')).toThrow(InvalidUriError);
      expect(() => router.parseEntityUri('https://example.com/universe/test-universe/galaxy/test-galaxy/star/test star/entity/user123')).toThrow(InvalidUriError);
      expect(() => router.parseEntityUri('https://example.com/universe/test-universe/galaxy/test-galaxy/star/test-star/entity/user 123')).toThrow(InvalidUriError);
    });

    test('should reject invalid entityType formats', () => {
      // Note: Entity type validation is now removed from URIs since entity type is no longer in the path
      // These tests are kept to document the change but now test other invalid URI formats
      
      // Missing entity ID
      expect(() => router.parseEntityUri('https://example.com/universe/test-universe/galaxy/test-galaxy/star/test-star/entity/')).toThrow(InvalidUriError);
      // Invalid entity ID with @
      expect(() => router.parseEntityUri('https://example.com/universe/test-universe/galaxy/test-galaxy/star/test-star/entity/user@invalid')).toThrow(InvalidUriError);
    });

    test('should reject invalid timestamp formats', () => {
      expect(() => router.parseEntityUri(testUris.currentEntity + '/at/invalid-timestamp')).toThrow(InvalidUriError);
      expect(() => router.parseEntityUri(testUris.currentEntity + '/at/2024-01-01T10:00:00')).toThrow(InvalidUriError); // Missing Z
      expect(() => router.parseEntityUri(testUris.currentEntity + '/patch/2024/01/01')).toThrow(InvalidUriError);
    });

    test('should validate during URI construction', () => {
      const invalidParams = {
        domain: 'example.com',
        universe: 'Test Universe', // Invalid: uppercase and space
        galaxy: 'test-galaxy',
        star: 'test-star',
        entityType: 'User@1.0',
        id: 'user123'
      };

      expect(() => {
        router.buildEntityUri(UriTemplateType.CURRENT_ENTITY, invalidParams);
      }).toThrow(InvalidUriError);
    });
  });

  describe('Error Handling', () => {
    test('should throw InvalidUriError for malformed URIs', () => {
      expect(() => router.parseEntityUri('not-a-valid-uri')).toThrow(InvalidUriError);
      expect(() => router.parseEntityUri('https://example.com/invalid/path')).toThrow(InvalidUriError);
    });

    test('should throw InvalidUriError for missing required parameters', () => {
      expect(() => router.parseEntityUri('https:///universe/test/galaxy/test/star/test/entity/User@1.0/123')).toThrow(InvalidUriError);
    });

    test('should throw InvalidUriError for unknown suffix', () => {
      expect(() => router.parseEntityUri(testUris.currentEntity + '/unknown-suffix')).toThrow(InvalidUriError);
    });

    test('should throw InvalidUriError for missing baseline in patch read', () => {
      expect(() => router.parseEntityUri(testUris.currentEntity + '/patch/')).toThrow(InvalidUriError);
    });

    test('should throw InvalidUriError for missing timestamp in historical', () => {
      expect(() => router.parseEntityUri(testUris.currentEntity + '/at/')).toThrow(InvalidUriError);
    });
  });

  describe('Performance', () => {
    test('should parse URIs quickly - performance benchmark', () => {
      const iterations = 1000;
      const start = performance.now();
      
      for (let i = 0; i < iterations; i++) {
        router.parseEntityUri(testUris.currentEntity);
        router.parseEntityUri(testUris.patchSubscription);
        router.parseEntityUri(testUris.patchRead);
        router.parseEntityUri(testUris.historical);
      }
      
      const end = performance.now();
      const totalTime = end - start;
      const timePerParse = totalTime / (iterations * 4);
      
      console.log(`Performance: ${iterations * 4} parses in ${totalTime.toFixed(3)}ms (${timePerParse.toFixed(3)}ms per parse)`);
      
      // Should be under 0.1ms per parse (much faster than the 30-44ms uri-template-router setup)
      expect(timePerParse).toBeLessThan(0.1);
    });
  });

  describe('URI Construction', () => {
    const testParams = {
      domain: 'example.com',
      universe: 'test-universe',
      galaxy: 'test-galaxy',
      star: 'test-star',
      id: 'user123'
    };

    test('should build current entity URI correctly', () => {
      const uri = router.buildEntityUri(UriTemplateType.CURRENT_ENTITY, testParams);
      expect(uri).toBe(testUris.currentEntity);
    });

    test('should build patch subscription URI correctly', () => {
      const uri = router.buildEntityUri(UriTemplateType.PATCH_SUBSCRIPTION, testParams);
      expect(uri).toBe(testUris.patchSubscription);
    });

    test('should build patch read URI correctly', () => {
      const patchParams = {
        ...testParams,
        baseline: '2024-01-01T10:00:00Z'
      };
      const uri = router.buildEntityUri(UriTemplateType.PATCH_READ, patchParams);
      expect(uri).toBe(testUris.patchRead);
    });

    test('should build historical URI correctly', () => {
      const historicalParams = {
        ...testParams,
        timestamp: '2024-01-01T10:00:00Z'
      };
      const uri = router.buildEntityUri(UriTemplateType.HISTORICAL, historicalParams);
      expect(uri).toBe(testUris.historical);
    });

    test('should throw error for unknown URI template type', () => {
      expect(() => {
        router.buildEntityUri('invalid-type' as UriTemplateType, testParams);
      }).toThrow(InvalidUriError);
    });
  });

  describe('Template Retrieval', () => {
    test('should return correct template for each type', () => {
      expect(router.getUriTemplate(UriTemplateType.CURRENT_ENTITY)).toBe(
        'https://{domain}/universe/{universe}/galaxy/{galaxy}/star/{star}/entity/{id}'
      );
      expect(router.getUriTemplate(UriTemplateType.PATCH_SUBSCRIPTION)).toBe(
        'https://{domain}/universe/{universe}/galaxy/{galaxy}/star/{star}/entity/{id}/patch'
      );
      expect(router.getUriTemplate(UriTemplateType.PATCH_READ)).toBe(
        'https://{domain}/universe/{universe}/galaxy/{galaxy}/star/{star}/entity/{id}/patch/{baseline}'
      );
      expect(router.getUriTemplate(UriTemplateType.HISTORICAL)).toBe(
        'https://{domain}/universe/{universe}/galaxy/{galaxy}/star/{star}/entity/{id}/at/{timestamp}'
      );
    });
  });

  describe('Resource Template Generation', () => {
    test('should generate correct resource templates (generic, not per entity type)', () => {
      const templates = router.getResourceTemplates();

      expect(templates).toHaveLength(4);

      // Current Entity Template
      const currentTemplate = templates.find(t => t.name.includes('Current Entity'));
      expect(currentTemplate).toBeDefined();
      expect(currentTemplate!.name).toBe('Current Entity');
      expect(currentTemplate!.uriTemplate).toBe('https://{domain}/universe/{universe}/galaxy/{galaxy}/star/{star}/entity/{id}');
      expect(currentTemplate!.description).toContain('Supports read, subscribe, and write operations');

      // Patch Template
      const patchTemplate = templates.find(t => t.name.includes('Patch Update and Subscribe'));
      expect(patchTemplate).toBeDefined();
      expect(patchTemplate!.name).toBe('Entity Patch Update and Subscribe');
      expect(patchTemplate!.uriTemplate).toBe('https://{domain}/universe/{universe}/galaxy/{galaxy}/star/{star}/entity/{id}/patch');
      expect(patchTemplate!.description).toContain('Patch-based operations for entities');

      // Patch from Baseline Template
      const patchFromBaselineTemplate = templates.find(t => t.name.includes('Get Entity Patch from Baseline'));
      expect(patchFromBaselineTemplate).toBeDefined();
      expect(patchFromBaselineTemplate!.name).toBe('Get Entity Patch from Baseline');
      expect(patchFromBaselineTemplate!.uriTemplate).toBe('https://{domain}/universe/{universe}/galaxy/{galaxy}/star/{star}/entity/{id}/patch/{baseline}');
      expect(patchFromBaselineTemplate!.description).toContain('RFC 7396 JSON merge patch');

      // Historical Template
      const historicalTemplate = templates.find(t => t.name.includes('Historical Entity'));
      expect(historicalTemplate).toBeDefined();
      expect(historicalTemplate!.name).toBe('Historical Entity');
      expect(historicalTemplate!.uriTemplate).toBe('https://{domain}/universe/{universe}/galaxy/{galaxy}/star/{star}/entity/{id}/at/{timestamp}');
      expect(historicalTemplate!.description).toContain('Historical snapshot of entity at specific timestamp');
    });
  });

  describe('Round-Trip Consistency', () => {
    const testCases = [
      {
        type: UriTemplateType.CURRENT_ENTITY,
        params: {
          domain: 'test.example.com',
          universe: 'production',
          galaxy: 'main',
          star: 'primary',
          id: 'order-12345'
        }
      },
      {
        type: UriTemplateType.PATCH_SUBSCRIPTION,
        params: {
          domain: 'dev.example.com',
          universe: 'test-env',
          galaxy: 'feature-branch',
          star: 'worker-1',
          id: 'product_abc_xyz'
        }
      },
      {
        type: UriTemplateType.PATCH_READ,
        params: {
          domain: 'api.example.com',
          universe: 'staging',
          galaxy: 'cluster-01',
          star: 'node-a',
          id: 'inv-2024-001',
          baseline: '2024-01-15T14:30:00.000Z'
        }
      },
      {
        type: UriTemplateType.HISTORICAL,
        params: {
          domain: 'archive.example.com',
          universe: 'historical',
          galaxy: 'backup',
          star: 'snapshot',
          id: 'cust_98765',
          timestamp: '2023-12-31T23:59:59.999Z'
        }
      }
    ];

    testCases.forEach(({ type, params }) => {
      test(`should maintain consistency for ${type} (build -> parse -> build)`, () => {
        // Build URI from parameters
        const builtUri = router.buildEntityUri(type, params);
        
        // Parse the built URI
        const parsed = router.parseEntityUri(builtUri);
        
        // Verify parsed type matches
        expect(parsed.type).toBe(type);
        
        // Verify all parameters match
        expect(parsed.params.domain).toBe(params.domain);
        expect(parsed.params.universe).toBe(params.universe);
        expect(parsed.params.galaxy).toBe(params.galaxy);
        expect(parsed.params.star).toBe(params.star);
        
        // Type assertion for entity URI params (not registry params)
        if (parsed.type !== UriTemplateType.ENTITY_REGISTRY) {
          expect((parsed.params as any).id).toBe(params.id);
        }
        
        // Verify type-specific parameters
        if (type === UriTemplateType.PATCH_READ) {
          expect((parsed.params as any).baseline).toBe((params as any).baseline);
        } else if (type === UriTemplateType.HISTORICAL) {
          expect((parsed.params as any).timestamp).toBe((params as any).timestamp);
        }
        
        // Build URI again from parsed parameters
        const rebuiltUri = router.buildEntityUri(parsed.type, parsed.params);
        
        // Verify round-trip consistency
        expect(rebuiltUri).toBe(builtUri);
      });
    });

    test('should handle valid characters in round-trip', () => {
      const params = {
        domain: 'test.example.com',
        universe: 'test-universe',
        galaxy: 'test-galaxy',
        star: 'test-star',
        id: 'id-with_underscores'
      };

      const builtUri = router.buildEntityUri(UriTemplateType.CURRENT_ENTITY, params);
      const parsed = router.parseEntityUri(builtUri);
      const rebuiltUri = router.buildEntityUri(parsed.type, parsed.params);

      expect(rebuiltUri).toBe(builtUri);
      expect(parsed.params.universe).toBe('test-universe');
      expect((parsed.params as any).id).toBe('id-with_underscores');
    });
  });

  describe('Template Consistency Validation', () => {
    test('should ensure URI templates match parsing regex patterns', () => {
      // This test validates that our URI_TEMPLATES constants are consistent with the parsing logic
      const baseParams = {
        domain: 'example.com',
        universe: 'test',
        galaxy: 'galaxy',
        star: 'star',
        entityType: 'Type@v1',
        id: 'id123'
      };

      // Test each template type
      Object.values(UriTemplateType).forEach(type => {
        let testParams: any = { ...baseParams };
        
        // Add type-specific parameters
        if (type === UriTemplateType.PATCH_READ) {
          testParams.baseline = '2024-01-01T00:00:00Z';
        } else if (type === UriTemplateType.HISTORICAL) {
          testParams.timestamp = '2024-01-01T00:00:00Z';
        }

        // Build URI using the template
        const builtUri = router.buildEntityUri(type, testParams);
        
        // Parse the built URI - this should not throw
        const parsed = router.parseEntityUri(builtUri);
        
        // The parsed type should match the original type
        expect(parsed.type).toBe(type);
      });
    });

    test('should validate all template constants are properly defined', () => {
      // Ensure all UriTemplateType enum values have corresponding templates
      Object.values(UriTemplateType).forEach(type => {
        expect(URI_TEMPLATES[type]).toBeDefined();
        expect(typeof URI_TEMPLATES[type]).toBe('string');
        expect(URI_TEMPLATES[type]).toMatch(/^https:\/\/{domain}\//);
      });
    });

    test('should validate template placeholders are consistent', () => {
      // All templates should have the base placeholders
      const basePlaceholders = ['{domain}', '{universe}', '{galaxy}', '{star}'];
      const entityPlaceholders = ['{id}']; // Note: {entityType} removed since it's no longer in URIs
      
      Object.entries(URI_TEMPLATES).forEach(([type, template]) => {
        basePlaceholders.forEach(placeholder => {
          expect(template).toContain(placeholder);
        });

        // Entity registry template doesn't have entity-specific placeholders
        if (type !== UriTemplateType.ENTITY_REGISTRY) {
          entityPlaceholders.forEach(placeholder => {
            expect(template).toContain(placeholder);
          });
        } else {
          // Entity registry should not have entity-specific placeholders
          entityPlaceholders.forEach(placeholder => {
            expect(template).not.toContain(placeholder);
          });
        }

        // Type-specific placeholder validation
        if (type === UriTemplateType.PATCH_READ) {
          expect(template).toContain('{baseline}');
        } else if (type === UriTemplateType.HISTORICAL) {
          expect(template).toContain('{timestamp}');
        } else {
          // These types should not have timestamp placeholders
          expect(template).not.toContain('{baseline}');
          expect(template).not.toContain('{timestamp}');
        }
      });
    });

    test('should ensure resource template generation uses correct templates', () => {
      const resourceTemplates = router.getResourceTemplates();

      // Verify each resource template matches the corresponding URI template
      const templateMap = {
        'Current Entity': UriTemplateType.CURRENT_ENTITY,
        'Entity Patch Update and Subscribe': UriTemplateType.PATCH_SUBSCRIPTION,
        'Get Entity Patch from Baseline': UriTemplateType.PATCH_READ,
        'Historical Entity': UriTemplateType.HISTORICAL
      };

      resourceTemplates.forEach(resourceTemplate => {
        const templateType = Object.entries(templateMap).find(([name]) => 
          resourceTemplate.name === name
        )?.[1];

        expect(templateType).toBeDefined();
        
        // The resource template URI should match the URI template exactly (no entity type substitution)
        const expectedUri = URI_TEMPLATES[templateType!];
        expect(resourceTemplate.uriTemplate).toBe(expectedUri);
      });
    });
  });
});
