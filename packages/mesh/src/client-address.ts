/**
 * A Client's address, and the one rule that tells it from a node's.
 *
 * A Client hosted by a node is named by that node's instance name, a `/`, and its own id: the
 * Client `alice.9f2c41aa` on the Star `acme.crm.tenant1` is `acme.crm.tenant1/alice.9f2c41aa`
 * under the Star's binding, and its address is the one string `STAR/acme.crm.tenant1/alice.9f2c41aa`.
 * A node's instance name never holds a `/`, so the `/` is the whole difference, and every reader
 * tells the two apart here.
 *
 * Client-safe: no Workers runtime import, so `@lumenize/mesh/client` re-exports it.
 */

/** Whether an instance name names a Client a node hosts, rather than a node. */
export function isClientInstanceName(instanceName: string | undefined): instanceName is string {
  return typeof instanceName === 'string' && instanceName.includes('/');
}

/**
 * The instance name of the object a message to `instanceName` reaches: the host node's for a
 * Client, `acme.crm.tenant1` for `acme.crm.tenant1/alice.9f2c41aa`, and the name itself for a node.
 */
export function hostInstanceOf(instanceName: string): string {
  const slash = instanceName.indexOf('/');
  return slash === -1 ? instanceName : instanceName.slice(0, slash);
}

/**
 * The one-string address of a mesh identity, `{binding}/{instance}`, as a subscription row stores
 * it. For a Client, pass `callChain[0]`, which its server-side half builds from the socket's
 * verified attachment: `{ bindingName: 'STAR', instanceName: 'acme.crm.tenant1/alice.9f2c41aa' }`
 * joins to `STAR/acme.crm.tenant1/alice.9f2c41aa`.
 *
 * @throws Error when the identity has no instance name, since a Worker hosts no Client.
 */
export function addressOf(identity: { bindingName: string; instanceName?: string }): string {
  if (!identity.instanceName) {
    throw new Error(`addressOf: '${identity.bindingName}' has no instance name, so it is no Client's address`);
  }
  return `${identity.bindingName}/${identity.instanceName}`;
}

/**
 * The binding and instance name a stored address calls: `STAR/acme.crm.tenant1/alice.9f2c41aa`
 * splits at its first `/` into `STAR` and `acme.crm.tenant1/alice.9f2c41aa`, the inverse of
 * {@link addressOf}.
 *
 * @throws Error when the address holds no `/`.
 */
export function splitAddress(address: string): { bindingName: string; instanceName: string } {
  const slash = address.indexOf('/');
  if (slash <= 0 || slash === address.length - 1) {
    throw new Error(`splitAddress: '${address}' is not a {binding}/{instance} address`);
  }
  return { bindingName: address.slice(0, slash), instanceName: address.slice(slash + 1) };
}
