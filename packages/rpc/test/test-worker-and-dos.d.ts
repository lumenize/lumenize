import { DurableObject } from 'cloudflare:workers';
import { Env } from 'cloudflare:test';
import { sharedDOMethods } from './shared/do-methods';
/**
 * Example Durable Object for testing RPC functionality
 * Implements shared methods directly to avoid 'this' typing issues
 */
declare class _ExampleDO extends DurableObject<Env> {
    readonly complexData: any;
    constructor(ctx: DurableObjectState, env: Env);
    fetch(request: Request): Promise<Response>;
}
interface _ExampleDO extends Omit<typeof sharedDOMethods, 'increment' | 'add' | 'throwError' | 'throwString' | 'slowIncrement' | 'getCounter'> {
    increment(): Promise<number>;
    add(a: number, b: number): number;
    throwError(message: string): void;
    throwString(message: string): void;
    slowIncrement(delayMs?: number): Promise<number>;
    getCounter(): Promise<number>;
}
declare const ExampleDO: typeof _ExampleDO;
export { ExampleDO };
/**
 * Subclass of ExampleDO for testing inheritance through RPC
 */
declare class _SubclassDO extends _ExampleDO {
    private readonly subclassProperty;
    multiply(a: number, b: number): number;
    doubleIncrement(): Promise<number>;
    increment(): Promise<number>;
    add(a: number, b: number): number;
    get subclassName(): string;
    getSubclassProperty(): string;
}
declare const SubclassDO: typeof _SubclassDO;
export { SubclassDO };
/**
 * Example Durable Object that uses manual routing instead of the factory
 * This demonstrates how to use handleRpcRequest directly for custom routing
 * Has same methods as ExampleDO for consistent testing
 */
export declare class ManualRoutingDO extends DurableObject<Env> {
    #private;
    readonly complexData: any;
    constructor(ctx: DurableObjectState, env: Env);
    fetch(request: Request): Promise<Response>;
    webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void>;
}
export interface ManualRoutingDO extends Omit<typeof sharedDOMethods, 'increment' | 'add' | 'throwError' | 'throwString' | 'slowIncrement' | 'getCounter'> {
    increment(): Promise<number>;
    add(a: number, b: number): number;
    throwError(message: string): void;
    throwString(message: string): void;
    slowIncrement(delayMs?: number): Promise<number>;
    getCounter(): Promise<number>;
}
/**
 * Worker fetch handler that uses routeDORequest to handle RPC requests
 * and falls back to existing Worker handlers/responses for non-RPC requests
 */
declare const _default: {
    fetch(request: Request, env: any): Promise<Response>;
    handleWorkerPing: (request: Request) => Response | undefined;
};
export default _default;
//# sourceMappingURL=test-worker-and-dos.d.ts.map