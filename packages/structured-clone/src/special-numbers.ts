/**
 * Special number serialization for NaN, Infinity, -Infinity
 * These cannot be represented in JSON directly
 */

/**
 * Marker types for special numbers
 */
export interface NaNMarker {
  __lmz_NaN: true;
}

export interface InfinityMarker {
  __lmz_Infinity: true;
}

export interface NegInfinityMarker {
  __lmz_NegInfinity: true;
}

export type SpecialNumberMarker = NaNMarker | InfinityMarker | NegInfinityMarker;

/**
 * Check if a value is a special number that needs serialization
 */
export function isSpecialNumber(value: any): boolean {
  return typeof value === 'number' && !isFinite(value);
}

/**
 * Serialize special numbers to markers
 */
export function serializeSpecialNumber(value: number): SpecialNumberMarker {
  if (Number.isNaN(value)) {
    return { __lmz_NaN: true };
  }
  if (value === Infinity) {
    return { __lmz_Infinity: true };
  }
  if (value === -Infinity) {
    return { __lmz_NegInfinity: true };
  }
  throw new Error(`Not a special number: ${value}`);
}

/**
 * Check if a value is a serialized special number marker
 */
export function isSerializedSpecialNumber(value: any): value is SpecialNumberMarker {
  return value && typeof value === 'object' && (
    value.__lmz_NaN === true ||
    value.__lmz_Infinity === true ||
    value.__lmz_NegInfinity === true
  );
}

/**
 * Deserialize special number markers back to numbers
 */
export function deserializeSpecialNumber(marker: SpecialNumberMarker): number {
  if ('__lmz_NaN' in marker) {
    return NaN;
  }
  if ('__lmz_Infinity' in marker) {
    return Infinity;
  }
  if ('__lmz_NegInfinity' in marker) {
    return -Infinity;
  }
  throw new Error('Unknown special number marker');
}

