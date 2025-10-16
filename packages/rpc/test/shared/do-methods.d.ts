/**
 * Shared Durable Object method implementations
 *
 * These methods can be mixed into both lumenizeRpcDO-wrapped DOs and
 * manual routing DOs to ensure consistent be  // Method for testing counter access (used by ManualRoutingDO)
  async getCounter(this: { ctx: DOContext }): Promise<number> {
    return (await this.ctx.storage.get('count') as number | undefined) || 0;
  }or across test configurations.
 */
type DOContext = any;
interface WithContext {
    readonly ctx: DOContext;
}
/**
 * Example class with methods on prototype (for testing prototype chain walking)
 */
export declare class DataModel {
    value: number;
    name: string;
    constructor(value: number, name: string);
    getValue(): number;
    getName(): string;
    compute(): number;
}
/**
 * Shared DO methods that can be mixed into any DO class
 * Use this by spreading into your DO class or copying methods
 */
export declare const sharedDOMethods: {
    increment(this: WithContext): Promise<number>;
    add(a: number, b: number): number;
    throwError(message: string): void;
    throwString(message: string): void;
    getObject(): {
        value: number;
        nested: {
            value: number;
            getValue(): number;
        };
    };
    getArray(): number[];
    getArrayWithFunctions(): any[];
    getProblematicObject(): any;
    getClassInstance(): DataModel;
    getDeeplyNested(): {
        level1: {
            level2: {
                level3: {
                    value: string;
                    getValue: () => string;
                };
            };
        };
    };
    getObjectWithNonFunction(): {
        notAFunction: number;
        data: {
            value: string;
        };
    };
    slowIncrement(this: {
        increment: () => Promise<number>;
    }, delayMs?: number): Promise<number>;
    getDate(): Date;
    getRegExp(): RegExp;
    getMap(): Map<string, string>;
    getSet(): Set<number>;
    getArrayBuffer(): ArrayBuffer;
    getTypedArray(): Uint8Array;
    getError(): Error;
    getCounter(this: WithContext): Promise<number>;
    echo(value: any): any;
};
/**
 * Helper to create complex data structure for testing
 * Used in DO constructor
 * @param doInstance - The DO instance to reference in circular refs
 * @param name - The name to use in getName() method (defaults to 'TestDO')
 */
export declare function createComplexData(doInstance: any, name?: string): {
    id: string;
    config: {
        name: string;
    };
    numbers: number[];
    methods: {
        getName: () => string;
    };
    collections: {
        tags: Set<string>;
        metadata: Map<string, any>;
    };
    data: any;
    parent: any;
};
export {};
//# sourceMappingURL=do-methods.d.ts.map