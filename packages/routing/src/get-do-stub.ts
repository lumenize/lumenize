import { isDurableObjectId } from './is-durable-object-id';

/**
 * Create a Durable Object stub from a namespace and instance identifier.
 * 
 * Automatically detects unique IDs (64-character hex strings) and uses the appropriate
 * method to create the stub: idFromString() + get() for unique IDs, or getByName() for named instances.
 * 
 * @param doNamespace - The resolved DurableObjectNamespace
 * @param doInstanceNameOrId - Instance name or unique ID string
 * @returns DurableObjectStub for the specified instance
 * 
 * @example
 * ```typescript
 * // Named instance
 * const stub = getDOStub(env.MY_DO, 'user-session-abc123');
 * 
 * // Unique ID (64-char hex string)
 * const stub = getDOStub(env.MY_DO, '8aa7a69131efa8902661702e701295f168aa5806045ec15d01a2f465bd5f3b99');
 * ```
 */
export function getDOStub(doNamespace: any, doInstanceNameOrId: string): any {
  if (isDurableObjectId(doInstanceNameOrId)) {
    // Unique ID: convert to DurableObjectId and get stub
    const id = doNamespace.idFromString(doInstanceNameOrId);
    return doNamespace.get(id);
  } else {
    // Named instance: get stub directly by name
    return doNamespace.getByName(doInstanceNameOrId);
  }
}
