export interface DOBindingError extends Error {
  code: 'BINDING_NOT_FOUND' | 'MULTIPLE_BINDINGS_FOUND';
  httpErrorCode: number;
  availableBindings: string[];
  attemptedBindings?: string[];
}

export class DOBindingNotFoundError extends Error implements DOBindingError {
  code: 'BINDING_NOT_FOUND' = 'BINDING_NOT_FOUND';
  httpErrorCode: number = 404;
  availableBindings: string[];
  attemptedBindings: string[];

  constructor(pathSegment: string, attemptedBindings: string[], availableBindings: string[]) {
    super(`Durable Object binding not found for path segment '${pathSegment}'. Tried: ${attemptedBindings.join(', ')}`);
    this.name = 'DOBindingNotFoundError';
    this.availableBindings = availableBindings;
    this.attemptedBindings = attemptedBindings;
  }
}

export class MultipleBindingsFoundError extends Error implements DOBindingError {
  code: 'MULTIPLE_BINDINGS_FOUND' = 'MULTIPLE_BINDINGS_FOUND';
  httpErrorCode: number = 400;
  availableBindings: string[];
  matchedBindings: string[];

  constructor(pathSegment: string, matchedBindings: string[]) {
    super(`Multiple Durable Object bindings found for path segment '${pathSegment}': ${matchedBindings.join(', ')}`);
    this.name = 'MultipleBindingsFoundError';
    this.availableBindings = matchedBindings;
    this.matchedBindings = matchedBindings;
  }
}

/**
 * Generate all possible case variations of a kebab-case path segment
 * to match against environment bindings.
 */
function generateBindingVariations(pathSegment: string): string[] {
  const variations = new Set<string>();
  
  // Original as-is
  variations.add(pathSegment);
  
  // SCREAMING_SNAKE_CASE (kebab-case → SNAKE_CASE)
  variations.add(pathSegment.toUpperCase().replace(/-/g, '_'));
  
  // snake_case
  variations.add(pathSegment.toLowerCase().replace(/-/g, '_'));
  
  // PascalCase (treat each segment as a word)
  const pascalCase = pathSegment
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join('');
  variations.add(pascalCase);
  
  // camelCase
  const camelCase = pathSegment
    .split('-')
    .map((word, index) => 
      index === 0 
        ? word.toLowerCase() 
        : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
    )
    .join('');
  variations.add(camelCase);
  
  // Handle edge cases like "my-d-o" → "MyDO"
  // Try treating single letters as separate words
  const segments = pathSegment.split('-');
  if (segments.some(seg => seg.length === 1)) {
    // All caps version: my-d-o → MYDO
    variations.add(pathSegment.replace(/-/g, '').toUpperCase());
    
    // Pascal with single letters: my-d-o → MyDO  
    const pascalWithSingleLetters = segments
      .map(seg => seg.toUpperCase())
      .join('');
    variations.add(pascalWithSingleLetters);
  }
  
  // Additional variation: MyDO style (PascalCase with final letters capitalized)
  if (pathSegment.includes('-')) {
    const parts = pathSegment.split('-');
    // Check if last part might be an acronym (2 letters or less)
    if (parts.length >= 2 && parts[parts.length - 1].length <= 2) {
      const pascalWithAcronym = parts
        .map((part, index) => 
          index === parts.length - 1 
            ? part.toUpperCase() // Last part as acronym
            : part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()
        )
        .join('');
      variations.add(pascalWithAcronym);
    }
  }
  
  return Array.from(variations);
}



/**
 * Get all Durable Object binding names from the environment.
 */
function getDurableObjectBindings(env: Record<string, any>): string[] {
  return Object.keys(env).filter(key => {
    const value = env[key];
    // Check if it looks like a DurableObjectNamespace
    // (has getByName, getById, etc. methods)
    return value && 
           typeof value === 'object' && 
           typeof value.getByName === 'function' &&
           typeof value.idFromName === 'function';
  });
}

/**
 * Find a Durable Object namespace from a path segment with intelligent case conversion.
 * 
 * @param pathSegment - The path segment that should match a DO binding (e.g., "my-do", "userSession")
 * @param env - The Cloudflare Workers environment object
 * @returns The DurableObjectNamespace for the matched binding
 * @throws {DOBindingNotFoundError} If no matching binding found
 * @throws {MultipleBindingsFoundError} If multiple bindings match
 * 
 * @example
 * ```typescript
 * // Path segment: "my-do"
 * // Env has: { MY_DO: durableObjectNamespace }
 * const namespace = getDONamespaceFromPathSegment('my-do', env);
 * 
 * // Path segment: "userSession"  
 * // Env has: { UserSession: durableObjectNamespace }
 * const namespace = getDONamespaceFromPathSegment('userSession', env);
 * ```
 */
export function getDONamespaceFromPathSegment(pathSegment: string, env: Record<string, any>): any {
  // Get all available DO bindings
  const availableBindings = getDurableObjectBindings(env);
  
  // Generate all possible case variations
  const variations = generateBindingVariations(pathSegment);
  
  // Find matches
  const matches = variations.filter(variation => 
    availableBindings.includes(variation)
  );
  
  if (matches.length === 0) {
    throw new DOBindingNotFoundError(pathSegment, variations, availableBindings);
  }
  
  if (matches.length > 1) {
    throw new MultipleBindingsFoundError(pathSegment, matches);
  }
  
  // Return the matched binding
  const bindingName = matches[0];
  return env[bindingName];
}


