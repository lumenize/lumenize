/**
 * Error thrown when multiple Durable Object bindings match the path segment.
 * 
 * This indicates an ambiguous binding resolution that requires more specific
 * environment configuration or path segment naming. This is a genuine 
 * configuration error that should be fixed.
 */
export class MultipleBindingsFoundError extends Error {
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
    // Check if the last part might be an acronym (2 letters or less)
    if (parts.length >= 2 && parts[parts.length - 1].length <= 2) {
      const pascalWithAcronym = parts
        .map((part, index) => 
          index === parts.length - 1 
            ? part.toUpperCase() // Treat final short part as acronym
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
 * This function bridges the gap between URL path segments (typically kebab-case) and
 * TypeScript/Cloudflare environment binding names (various case conventions). It generates
 * multiple case variations of the path segment and finds the matching binding in the environment.
 * 
 * **Supported Case Conversions:**
 * - `my-do` → `MY_DO` (SCREAMING_SNAKE_CASE)
 * - `user-session` → `UserSession` (PascalCase)  
 * - `chat-room` → `chatRoom` (camelCase)
 * - `my-d-o` → `MyDO` (handles acronyms)
 * 
 * **Return Behavior:**
 * - Returns the DurableObjectNamespace if exactly one match is found
 * - Returns `undefined` if no matching binding is found (no-match scenario)
 * - Throws `MultipleBindingsFoundError` if multiple bindings match (configuration error)
 * 
 * @param pathSegment - The path segment that should match a DO binding
 * @param env - The Cloudflare Workers environment object containing DO bindings
 * @returns The DurableObjectNamespace for the uniquely matched binding, or undefined if no match
 * @throws {MultipleBindingsFoundError} If multiple bindings match the path segment (genuine error)
 * 
 * @example
 * ```typescript
 * // Kebab-case to SCREAMING_SNAKE_CASE
 * // URL: /my-do/instance → Binding: MY_DO
 * const namespace = getDONamespaceFromPathSegment('my-do', { MY_DO: myDoNamespace });
 * // → Returns myDoNamespace
 * 
 * // camelCase to PascalCase
 * // URL: /userSession/abc → Binding: UserSession  
 * const namespace = getDONamespaceFromPathSegment('userSession', { UserSession: userNamespace });
 * // → Returns userNamespace
 * 
 * // Handles acronyms intelligently
 * // URL: /chat-d-o/room → Binding: ChatDO
 * const namespace = getDONamespaceFromPathSegment('chat-d-o', { ChatDO: chatNamespace });
 * // → Returns chatNamespace
 * 
 * // No match cases return undefined
 * const namespace = getDONamespaceFromPathSegment('unknown', env);
 * // → undefined
 * 
 * // Multiple matches throw error
 * try {
 *   const namespace = getDONamespaceFromPathSegment('ambiguous', { 
 *     AMBIGUOUS: ns1, 
 *     Ambiguous: ns2 
 *   });
 * } catch (error) {
 *   if (error instanceof MultipleBindingsFoundError) {
 *     console.log('Matched bindings:', error.matchedBindings);
 *   }
 * }
 * ```
 */
export function getDONamespaceFromPathSegment(pathSegment: string, env: Record<string, any>): any | undefined {
  // Get all available DO bindings
  const availableBindings = getDurableObjectBindings(env);
  
  // Generate all possible case variations
  const variations = generateBindingVariations(pathSegment);
  
  // Find matches
  const matches = variations.filter(variation => 
    availableBindings.includes(variation)
  );
  
  if (matches.length === 0) {
    return undefined; // No match - binding not found
  }
  
  if (matches.length > 1) {
    throw new MultipleBindingsFoundError(pathSegment, matches);
  }
  
  // Success: exactly one match found, return the namespace
  const bindingName = matches[0];
  return env[bindingName];
}
