import { InvalidUriError } from './errors';
import { ResourceTemplate } from './schema/draft/schema';

/**
 * Template types for entity URIs
 */
export enum UriTemplateType {
  CURRENT_ENTITY = 'current',
  PATCH_SUBSCRIPTION = 'patch_subscription', 
  PATCH_READ = 'patch_read',
  HISTORICAL = 'historical',
  ENTITY_REGISTRY = 'entity_registry'
}

/**
 * URI template constants - single source of truth for all URI formats
 */
export const URI_TEMPLATES = {
  [UriTemplateType.CURRENT_ENTITY]: 'https://{domain}/universe/{universe}/galaxy/{galaxy}/star/{star}/entity/{id}',
  [UriTemplateType.PATCH_SUBSCRIPTION]: 'https://{domain}/universe/{universe}/galaxy/{galaxy}/star/{star}/entity/{id}/patch',
  [UriTemplateType.PATCH_READ]: 'https://{domain}/universe/{universe}/galaxy/{galaxy}/star/{star}/entity/{id}/patch/{baseline}',
  [UriTemplateType.HISTORICAL]: 'https://{domain}/universe/{universe}/galaxy/{galaxy}/star/{star}/entity/{id}/at/{timestamp}',
  [UriTemplateType.ENTITY_REGISTRY]: 'https://{domain}/universe/{universe}/galaxy/{galaxy}/star/{star}/entity-types'
} as const;

/**
 * Base parameters common to all entity URIs
 */
export interface EntityUriParams {
  domain: string;
  universe: string;
  galaxy: string;
  star: string;
  id: string;
}

/**
 * Parameters for patch read URIs
 */
export interface PatchUriParams extends EntityUriParams {
  baseline: string;
}

/**
 * Parameters for historical URIs
 */
export interface HistoricalUriParams extends EntityUriParams {
  timestamp: string;
}

/**
 * Parameters for entity registry URIs
 */
export interface EntityRegistryUriParams {
  domain: string;
  universe: string;
  galaxy: string;
  star: string;
}

/**
 * Result of parsing a URI
 */
export interface ParsedUri {
  type: UriTemplateType;
  params: EntityUriParams | PatchUriParams | HistoricalUriParams | EntityRegistryUriParams;
}

/**
 * Fast manual entity URI parser that replaces uri-template-router
 * 
 * Handles four distinct URI templates:
 * 1. Current entity: https://{domain}/universe/{universe}/galaxy/{galaxy}/star/{star}/entity/{id}
 * 2. Patch subscription: https://{domain}/universe/{universe}/galaxy/{galaxy}/star/{star}/entity/{id}/patch
 * 3. Patch read: https://{domain}/universe/{universe}/galaxy/{galaxy}/star/{star}/entity/{id}/patch/{baseline}
 * 4. Historical: https://{domain}/universe/{universe}/galaxy/{galaxy}/star/{star}/entity/{id}/at/{timestamp}
 */
export class EntityUriRouter {
  // Pre-compiled regex for maximum performance  
  private static readonly ENTITY_URI_PATTERN = /^https:\/\/([^\/]+)\/universe\/([^\/]+)\/galaxy\/([^\/]+)\/star\/([^\/]+)\/entity\/([^\/]+)(?:\/(.+))?$/;
  
  // Regex for entity registry URIs
  private static readonly ENTITY_REGISTRY_PATTERN = /^https:\/\/([^\/]+)\/universe\/([^\/]+)\/galaxy\/([^\/]+)\/star\/([^\/]+)\/entity-types$/;

  // Validation patterns for URI components
  private static readonly VALIDATION_PATTERNS = {
    // lowercase alpha, numbers, "-", "_"
    universe: /^[a-z0-9_-]+$/,
    galaxy: /^[a-z0-9_-]+$/,
    star: /^[a-z0-9_-]+$/,
    
    // entity type names can use PascalCase: letters, numbers, "-", "_"
    entityTypeName: /^[a-zA-Z0-9_-]+$/,
    
    // same as above but also allows "."
    domain: /^[a-z0-9._-]+$/,
    entityTypeVersion: /^[a-zA-Z0-9._-]+$/,
    
    // user-provided ID - allow letters, numbers, hyphens, underscores
    id: /^[a-zA-Z0-9._-]+$/,
    
    // canonical ISO-8601: YYYY-MM-DDTHH:mm:ss(.sss)?Z
    timestamp: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/
  };

  /**
   * Parse entity URI and determine which template it matches
   * @param uri - MCP resource URI
   * @returns Parsed URI with type and parameters
   * @throws InvalidUriError if URI doesn't match any template
   */
  parseEntityUri(uri: string): ParsedUri {
    // First check if it's an entity registry URI
    const registryMatch = uri.match(EntityUriRouter.ENTITY_REGISTRY_PATTERN);
    if (registryMatch) {
      const [, domain, universe, galaxy, star] = registryMatch;
      
      // Validate required parameters
      if (!domain || !universe || !galaxy || !star) {
        throw new InvalidUriError('Missing required URI parameters for entity registry');
      }

      const params: EntityRegistryUriParams = {
        domain: decodeURIComponent(domain),
        universe: decodeURIComponent(universe),
        galaxy: decodeURIComponent(galaxy),
        star: decodeURIComponent(star)
      };

      // Validate components (excluding entity-specific validations)
      this.validateComponent('domain', params.domain, EntityUriRouter.VALIDATION_PATTERNS.domain);
      this.validateComponent('universe', params.universe, EntityUriRouter.VALIDATION_PATTERNS.universe);
      this.validateComponent('galaxy', params.galaxy, EntityUriRouter.VALIDATION_PATTERNS.galaxy);
      this.validateComponent('star', params.star, EntityUriRouter.VALIDATION_PATTERNS.star);

      return {
        type: UriTemplateType.ENTITY_REGISTRY,
        params
      };
    }

    // If not entity registry, try regular entity URI pattern
    const match = uri.match(EntityUriRouter.ENTITY_URI_PATTERN);
    if (!match) {
      throw new InvalidUriError(`Invalid entity URI format: ${uri}`);
    }

    const [, domain, universe, galaxy, star, id, suffix] = match;

    // Validate required parameters
    if (!domain || !universe || !galaxy || !star || !id) {
      throw new InvalidUriError('Missing required URI parameters');
    }

    // Decode URI components (still needed for backwards compatibility with encoded URIs)
    const baseParams: EntityUriParams = {
      domain: decodeURIComponent(domain),
      universe: decodeURIComponent(universe),
      galaxy: decodeURIComponent(galaxy),
      star: decodeURIComponent(star),
      id: decodeURIComponent(id)
    };

    // Validate decoded components
    this.validateUriComponents(baseParams);

    // Determine template type and extract additional parameters based on suffix
    if (!suffix) {
      // Template 1: Current entity
      return {
        type: UriTemplateType.CURRENT_ENTITY,
        params: baseParams
      };
    }

    if (suffix === 'patch') {
      // Template 2: Patch subscription
      return {
        type: UriTemplateType.PATCH_SUBSCRIPTION,
        params: baseParams
      };
    }

    if (suffix.startsWith('patch/')) {
      // Template 3: Patch read
      const baseline = suffix.substring(6); // Remove 'patch/' prefix
      if (!baseline) {
        throw new InvalidUriError('Missing baseline for patch read URI');
      }
      const decodedTimestamp = decodeURIComponent(baseline);
      this.validateTimestamp(decodedTimestamp);
      return {
        type: UriTemplateType.PATCH_READ,
        params: {
          ...baseParams,
          baseline: decodedTimestamp
        } as PatchUriParams
      };
    }

    if (suffix.startsWith('at/')) {
      // Template 4: Historical
      const timestamp = suffix.substring(3); // Remove 'at/' prefix
      if (!timestamp) {
        throw new InvalidUriError('Missing timestamp for historical URI');
      }
      const decodedTimestamp = decodeURIComponent(timestamp);
      this.validateTimestamp(decodedTimestamp);
      return {
        type: UriTemplateType.HISTORICAL,
        params: {
          ...baseParams,
          timestamp: decodedTimestamp
        } as HistoricalUriParams
      };
    }

    throw new InvalidUriError(`Unknown URI suffix: ${suffix}`);
  }

  /**
   * Construct entity URI from parameters
   * @param type - URI template type
   * @param params - URI parameters
   * @returns Constructed URI string
   */
  buildEntityUri(type: UriTemplateType, params: EntityUriParams | PatchUriParams | HistoricalUriParams | EntityRegistryUriParams): string {
    const template = URI_TEMPLATES[type];
    
    if (!template) {
      throw new InvalidUriError(`Unknown URI template type: ${type}`);
    }
    
    // Handle entity registry URIs differently (no entity type or ID)
    if (type === UriTemplateType.ENTITY_REGISTRY) {
      const registryParams = params as EntityRegistryUriParams;
      
      // Validate components (excluding entity-specific validations)
      this.validateComponent('domain', registryParams.domain, EntityUriRouter.VALIDATION_PATTERNS.domain);
      this.validateComponent('universe', registryParams.universe, EntityUriRouter.VALIDATION_PATTERNS.universe);
      this.validateComponent('galaxy', registryParams.galaxy, EntityUriRouter.VALIDATION_PATTERNS.galaxy);
      this.validateComponent('star', registryParams.star, EntityUriRouter.VALIDATION_PATTERNS.star);
      
      return template
        .replace('{domain}', registryParams.domain)
        .replace('{universe}', registryParams.universe)
        .replace('{galaxy}', registryParams.galaxy)
        .replace('{star}', registryParams.star);
    }
    
    // Handle entity URIs
    const entityParams = params as EntityUriParams | PatchUriParams | HistoricalUriParams;
    
    // Validate all components before building
    this.validateUriComponents(entityParams);
    
    // Build URI without encoding (since all components are validated)
    let uri = template
      .replace('{domain}', entityParams.domain)
      .replace('{universe}', entityParams.universe)
      .replace('{galaxy}', entityParams.galaxy)
      .replace('{star}', entityParams.star)
      .replace('{id}', entityParams.id);

    // Handle type-specific parameters
    switch (type) {
      case UriTemplateType.PATCH_READ:
        const patchParams = entityParams as PatchUriParams;
        this.validateTimestamp(patchParams.baseline);
        uri = uri.replace('{baseline}', patchParams.baseline);
        break;
      case UriTemplateType.HISTORICAL:
        const historicalParams = entityParams as HistoricalUriParams;
        this.validateTimestamp(historicalParams.timestamp);
        uri = uri.replace('{timestamp}', historicalParams.timestamp);
        break;
      case UriTemplateType.CURRENT_ENTITY:
      case UriTemplateType.PATCH_SUBSCRIPTION:
        // No additional parameters needed
        break;
      default:
        throw new InvalidUriError(`Unknown URI template type: ${type}`);
    }

    return uri;
  }

  /**
   * Get URI template string for a specific type
   * @param type - URI template type
   * @returns URI template with placeholder variables
   */
  getUriTemplate(type: UriTemplateType): string {
    return URI_TEMPLATES[type];
  }

  /**
   * Get all URI templates as resource templates for MCP protocol
   * @returns Array of generic resource templates
   */
  getResourceTemplates(): ResourceTemplate[] {
    const templates: ResourceTemplate[] = [];

    // Template 1: Current Entity Resource
    templates.push({
      name: 'Current Entity',
      uriTemplate: URI_TEMPLATES[UriTemplateType.CURRENT_ENTITY],
      description: 'Current entity resource. Supports read, subscribe, and write operations.'
    });

    // Template 2: Patch Update/Subscribe Resource
    templates.push({
      name: 'Entity Patch Update and Subscribe',
      uriTemplate: URI_TEMPLATES[UriTemplateType.PATCH_SUBSCRIPTION],
      description: 'Patch-based operations for entities. Supports patch updates with baseline validation and patch-based subscriptions.'
    });

    // Template 3: Patch Read Resource
    templates.push({
      name: 'Get Entity Patch from Baseline',
      uriTemplate: URI_TEMPLATES[UriTemplateType.PATCH_READ],
      description: 'RFC 7396 JSON merge patch from baseline timestamp to current state. Read-only.'
    });

    // Template 4: Historical Point-in-Time Resource
    templates.push({
      name: 'Historical Entity',
      uriTemplate: URI_TEMPLATES[UriTemplateType.HISTORICAL],
      description: 'Historical snapshot of entity at specific timestamp. Read-only.'
    });

    return templates;
  }

  /**
   * Get entity registry resource template for MCP protocol
   * @param domain - Domain for the template
   * @param universe - Universe for the template  
   * @param galaxy - Galaxy for the template
   * @param star - Star for the template
   * @returns Entity registry resource template
   */
  getEntityRegistryResourceTemplate(domain: string, universe: string, galaxy: string, star: string): ResourceTemplate {
    const template = URI_TEMPLATES[UriTemplateType.ENTITY_REGISTRY]
      .replace('{domain}', domain)
      .replace('{universe}', universe)
      .replace('{galaxy}', galaxy)
      .replace('{star}', star);

    return {
      name: 'Entity Type Registry',
      uriTemplate: template,
      description: 'Complete registry of all entity type definitions available in this star. Returns JSON containing all entity types with their schemas, versions, and metadata.',
      mimeType: 'application/json'
    };
  }

  /**
   * Validate URI components according to format rules
   * @param params - URI parameters to validate
   * @throws InvalidUriError if any component is invalid
   */
  private validateUriComponents(params: EntityUriParams | PatchUriParams | HistoricalUriParams): void {
    this.validateComponent('domain', params.domain, EntityUriRouter.VALIDATION_PATTERNS.domain);
    this.validateComponent('universe', params.universe, EntityUriRouter.VALIDATION_PATTERNS.universe);
    this.validateComponent('galaxy', params.galaxy, EntityUriRouter.VALIDATION_PATTERNS.galaxy);
    this.validateComponent('star', params.star, EntityUriRouter.VALIDATION_PATTERNS.star);
    this.validateComponent('id', params.id, EntityUriRouter.VALIDATION_PATTERNS.id);
    
    // Note: Entity type validation removed since it's no longer part of URI
  }

  /**
   * Validate a single URI component
   * @param name - Component name for error messages
   * @param value - Component value to validate
   * @param pattern - Regex pattern to validate against
   * @throws InvalidUriError if component is invalid
   */
  private validateComponent(name: string, value: string, pattern: RegExp): void {
    if (!pattern.test(value)) {
      let formatDescription = '';
      if (name === 'universe' || name === 'galaxy' || name === 'star') {
        formatDescription = ' Must contain only lowercase letters, numbers, hyphens, and underscores.';
      } else if (name === 'domain') {
        formatDescription = ' Must contain only lowercase letters, numbers, periods, hyphens, and underscores.';
      } else if (name === 'entityTypeName' || name === 'id') {
        formatDescription = ' Must contain only letters, numbers, hyphens, and underscores.';
      } else if (name === 'entityTypeVersion') {
        formatDescription = ' Must contain only letters, numbers, periods, hyphens, and underscores.';
      }
      throw new InvalidUriError(`Invalid ${name}: '${value}' does not match required format.${formatDescription}`);
    }
  }

  /**
   * Validate entityType format (name@version)
   * @param entityType - Entity type to validate
   * @throws InvalidUriError if entityType format is invalid
   */
  private validateEntityType(entityType: string): void {
    const atIndex = entityType.indexOf('@');
    if (atIndex === -1) {
      throw new InvalidUriError(`Invalid entityType: '${entityType}' must contain @ separator (format: name@version)`);
    }
    
    const entityTypeName = entityType.substring(0, atIndex);
    const entityTypeVersion = entityType.substring(atIndex + 1);
    
    if (!entityTypeName || !entityTypeVersion) {
      throw new InvalidUriError(`Invalid entityType: '${entityType}' must have both name and version parts (format: name@version)`);
    }
    
    this.validateComponent('entityTypeName', entityTypeName, EntityUriRouter.VALIDATION_PATTERNS.entityTypeName);
    this.validateComponent('entityTypeVersion', entityTypeVersion, EntityUriRouter.VALIDATION_PATTERNS.entityTypeVersion);
  }

  /**
   * Validate timestamp format (canonical ISO-8601)
   * @param timestamp - Timestamp to validate
   * @throws InvalidUriError if timestamp format is invalid
   */
  private validateTimestamp(timestamp: string): void {
    if (!EntityUriRouter.VALIDATION_PATTERNS.timestamp.test(timestamp)) {
      throw new InvalidUriError(`Invalid timestamp: '${timestamp}' must be canonical ISO-8601 format (YYYY-MM-DDTHH:mm:ss.sssZ)`);
    }
  }
}
