/**
 * Type declarations for @ungap/structured-clone/json submodule
 * 
 * The /json submodule provides JSON-compatible stringify/parse functions
 * that handle structured cloning of complex types not supported by JSON.stringify
 */
declare module '@ungap/structured-clone/json' {
  /**
   * Serialize a value using structured clone algorithm with JSON encoding
   */
  export function stringify(value: any): string;
  
  /**
   * Deserialize a value using structured clone algorithm with JSON decoding
   */
  export function parse(text: string): any;
}
