/**
 * JSON Merge Patch implementation (RFC 7396)
 * 
 * Based on json-merge-patch npm package v1.0.2
 * Original Copyright (c) 2015 Pierre Inglebert
 * Licensed under MIT License
 * 
 * Modified for Lumenize:
 * - Converted to TypeScript
 * - Returns {} instead of undefined when no changes detected
 * - Added proper type definitions
 */

// Simple deep equality check (replaces fast-deep-equal dependency)
function deepEqual(a: any, b: any): boolean {
  if (a === b) return true;
  
  if (a == null || b == null) return a === b;
  
  if (typeof a !== typeof b) return false;
  
  if (typeof a !== 'object') return false;
  
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  
  if (keysA.length !== keysB.length) return false;
  
  for (const key of keysA) {
    if (!keysB.includes(key)) return false;
    if (!deepEqual(a[key], b[key])) return false;
  }
  
  return true;
}

// Serialize values (handles toJSON if present)
function serialize(value: any): any {
  return (value && typeof value.toJSON === 'function') ? value.toJSON() : value;
}

// Check if arrays are equal
function arrayEquals(before: any[], after: any[]): boolean {
  if (before.length !== after.length) {
    return false;
  }
  for (let i = 0; i < before.length; i++) {
    if (!deepEqual(after[i], before[i])) {
      return false;
    }
  }
  return true;
}

/**
 * Generate a JSON Merge Patch between two objects
 * 
 * @param before - The original object
 * @param after - The target object after changes
 * @returns JSON Merge Patch object (empty object {} if no changes)
 */
export function generate(before: any, after: any): Record<string, any> {
  before = serialize(before);
  after = serialize(after);

  if (before === null || after === null ||
    typeof before !== 'object' || typeof after !== 'object' ||
    Array.isArray(before) !== Array.isArray(after)) {
    return after;
  }

  if (Array.isArray(before)) {
    if (!arrayEquals(before, after)) {
      return after;
    }
    // Modified: return {} instead of undefined for consistency
    return {};
  }

  const patch: Record<string, any> = {};
  const beforeKeys = Object.keys(before);
  const afterKeys = Object.keys(after);

  // New elements
  const newKeys: Record<string, boolean> = {};
  for (const key of afterKeys) {
    if (beforeKeys.indexOf(key) === -1) {
      newKeys[key] = true;
      patch[key] = serialize(after[key]);
    }
  }

  // Removed & modified elements
  for (const key of beforeKeys) {
    if (afterKeys.indexOf(key) === -1) {
      patch[key] = null;
    } else {
      if (before[key] !== null && typeof before[key] === 'object') {
        const subPatch = generate(before[key], after[key]);
        // Only add subPatch if it's not empty
        if (Object.keys(subPatch).length > 0) {
          patch[key] = subPatch;
        }
      } else if (before[key] !== after[key]) {
        patch[key] = serialize(after[key]);
      }
    }
  }

  // Modified: return {} instead of undefined when no changes
  return Object.keys(patch).length > 0 ? patch : {};
}

/**
 * Apply a JSON Merge Patch to an object
 * 
 * @param target - The object to patch
 * @param patch - The JSON Merge Patch to apply
 * @returns The patched object
 */
export function apply(target: any, patch: any): any {
  patch = serialize(patch);
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    return patch;
  }

  target = serialize(target);
  if (target === null || typeof target !== 'object' || Array.isArray(target)) {
    target = {};
  }
  
  const keys = Object.keys(patch);
  for (const key of keys) {
    // Security: prevent prototype pollution
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      return target;
    }
    if (patch[key] === null) {
      if (target.hasOwnProperty(key)) {
        delete target[key];
      }
    } else {
      target[key] = apply(target[key], patch[key]);
    }
  }
  return target;
}

/**
 * Check if a patch represents "no changes"
 * 
 * @param patch - The patch to check
 * @returns true if the patch represents no changes
 */
export function isEmpty(patch: any): boolean {
  return patch != null && 
         typeof patch === 'object' && 
         !Array.isArray(patch) && 
         Object.keys(patch).length === 0;
}
