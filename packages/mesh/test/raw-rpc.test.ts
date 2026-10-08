/**
 * The `@rawRpc()` bridge (ADR-023): `rawRpcStub` reaches a node's one `__rawRpc` entry, which checks
 * that the binding and instance name it is handed name this object, refuses any name `@rawRpc()` did
 * not decorate, stamps the node's identity as the mesh path does, and invokes the method.
 *
 * In-lane, since only code holding the binding can make this call, and a running system holds it
 * only inside our own Worker (`testing.md`).
 */
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { rawRpcStub } from '../src/raw-rpc';

const name = (label: string) => `raw_${label}_${crypto.randomUUID().slice(0, 8)}`;
const entry = (instance: string) =>
  (env.TEST_DO.getByName(instance) as unknown as {
    __rawRpc(binding: string, instanceName: string, method: string, args: unknown[]): Promise<unknown>;
  });

describe('@rawRpc() and rawRpcStub', () => {
  it('runs a decorated method and stamps the identity the stub names', async () => {
    const instance = name('echo');
    expect(await rawRpcStub('TEST_DO', instance).rawRpcEcho('hello'))
      .toEqual({ value: 'hello', bindingName: 'TEST_DO', instanceName: instance });
  });

  it('refuses a method @rawRpc() did not decorate', async () => {
    await expect(rawRpcStub('TEST_DO', name('plain')).notRawRpc())
      .rejects.toThrow(`'notRawRpc' is not @rawRpc()-decorated`);
  });

  it('refuses a getter and a dotted path, looking up one name', async () => {
    const instance = name('path');
    await expect(entry(instance).__rawRpc('TEST_DO', instance, 'lmz', []))
      .rejects.toThrow(`'lmz' is not @rawRpc()-decorated`);
    await expect(entry(instance).__rawRpc('TEST_DO', instance, 'lmz.call', []))
      .rejects.toThrow(`'lmz.call' is not @rawRpc()-decorated`);
  });

  // The pair is verified, not trusted: `idFromName` equals `ctx.id` only for the binding and name
  // that address this object, measured here.
  it('refuses a pair that does not name this object: another instance, or another binding', async () => {
    const instance = name('pair');
    await expect(entry(instance).__rawRpc('TEST_DO', `${instance}-other`, 'rawRpcEcho', ['x']))
      .rejects.toThrow(`TEST_DO/${instance}-other does not name this Durable Object`);
    await expect(entry(instance).__rawRpc('ECHO_DO', instance, 'rawRpcEcho', ['x']))
      .rejects.toThrow(`ECHO_DO/${instance} does not name this Durable Object`);
    // Positive control: the right pair, through the same entry.
    expect(await entry(instance).__rawRpc('TEST_DO', instance, 'rawRpcEcho', ['x']))
      .toEqual({ value: 'x', bindingName: 'TEST_DO', instanceName: instance });
  });
});
