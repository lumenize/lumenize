/**
 * Shared Durable Object method implementations
 *
 * These methods can be mixed into both lumenizeRpcDO-wrapped DOs and
 * manual routing DOs to ensure consistent be  // Method for testing counter access (used by ManualRoutingDO)
  async getCounter(this: { ctx: DOContext }): Promise<number> {
    return (await this.ctx.storage.get('count') as number | undefined) || 0;
  }or across test configurations.
 */
/**
 * Example class with methods on prototype (for testing prototype chain walking)
 */
export class DataModel {
    value;
    name;
    constructor(value, name) {
        this.value = value;
        this.name = name;
    }
    getValue() {
        return this.value;
    }
    getName() {
        return this.name;
    }
    compute() {
        return this.value * 2;
    }
}
/**
 * Shared DO methods that can be mixed into any DO class
 * Use this by spreading into your DO class or copying methods
 */
export const sharedDOMethods = {
    // Simple method
    async increment() {
        const count = await this.ctx.storage.get('count') || 0;
        const newCount = count + 1;
        this.ctx.storage.kv.put('count', newCount);
        return newCount;
    },
    // Method with arguments
    add(a, b) {
        return a + b;
    },
    // Method that throws an error (for testing error handling)
    throwError(message) {
        const error = new Error(message);
        error.code = 'TEST_ERROR';
        error.statusCode = 400;
        error.metadata = { timestamp: Date.now(), source: 'SharedDOMethods' };
        throw error;
    },
    // Method that throws a string (not an Error object)
    throwString(message) {
        throw message; // This throws a string, not an Error instance
    },
    // Method that returns object with remote functions (for testing preprocessing)
    getObject() {
        const nested = {
            value: 42,
            getValue() {
                return this.value;
            }
        };
        return {
            value: 42,
            nested
        };
    },
    // Method that returns array
    getArray() {
        return [1, 2, 3, 4, 5];
    },
    // Method that returns array with functions (for testing array preprocessing)
    getArrayWithFunctions() {
        return [
            1,
            2,
            () => 'hello',
            { value: 42, getValue: function () { return this.value; } },
            5
        ];
    },
    // Method that returns an object that will cause preprocessing to throw
    // This uses a getter that throws when accessed
    getProblematicObject() {
        const obj = { value: 42 };
        Object.defineProperty(obj, 'badGetter', {
            get() {
                throw new Error('Getter throws error');
            },
            enumerable: true
        });
        return obj;
    },
    // Method that returns a class instance (for testing prototype chain walking)
    getClassInstance() {
        return new DataModel(42, 'TestModel');
    },
    // Method that returns an object with deeply nested properties for testing chaining
    getDeeplyNested() {
        return {
            level1: {
                level2: {
                    level3: {
                        value: 'deep',
                        getValue: () => 'deeply nested value'
                    }
                }
            }
        };
    },
    // Method that returns an object with a non-function property to test error handling
    getObjectWithNonFunction() {
        return {
            notAFunction: 42,
            data: { value: 'test' }
        };
    },
    // Method with built-in delay for testing pending operations
    async slowIncrement(delayMs = 100) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
        return this.increment();
    },
    // Methods for testing built-in type handling
    getDate() {
        return new Date('2025-01-01T00:00:00Z');
    },
    getRegExp() {
        return /[0-9]+/g;
    },
    getMap() {
        return new Map([['key', 'value']]);
    },
    getSet() {
        return new Set([1, 2, 3]);
    },
    getArrayBuffer() {
        return new ArrayBuffer(8);
    },
    getTypedArray() {
        return new Uint8Array([1, 2, 3, 4]);
    },
    getError() {
        return new Error('Test error');
    },
    // Method for testing counter access (used by ManualRoutingDO)
    async getCounter() {
        return await this.ctx.storage.get('count') || 0;
    },
    // Method that echoes back whatever is passed to it (for testing structured-clone and circular refs)
    echo(value) {
        return value;
    }
};
/**
 * Helper to create complex data structure for testing
 * Used in DO constructor
 * @param doInstance - The DO instance to reference in circular refs
 * @param name - The name to use in getName() method (defaults to 'TestDO')
 */
export function createComplexData(doInstance, name = 'TestDO') {
    const complexData = {
        id: 'complex-data',
        config: {
            name
        },
        numbers: [1, 2, 3],
        methods: {
            getName: () => name
        },
        collections: {
            tags: new Set(['test', 'rpc']),
            metadata: new Map([
                ['created', Date.now()],
                ['features', ['increment', 'add']]
            ])
        },
        data: null, // Will point back to root
        parent: null // Will point back to DO instance
    };
    // Create circular references
    complexData.data = complexData; // Points back to root
    complexData.parent = doInstance; // Points back to DO instance
    return complexData;
}
//# sourceMappingURL=do-methods.js.map