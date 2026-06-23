/**
 * Spike A Stage 2 — facet env-injection harness. NOT production code.
 *
 * `SecretBrokerDO` is a stand-in "capability broker": it seals secrets at two
 * mock levels (its own KV), resolves one per the configured mode (reusing the
 * Stage-1 vault), loads a throwaway facet with ONLY the resolved plaintext in a
 * custom `env`, and asks the facet to prove it received the value WITHOUT
 * leaking it — while demonstrating the facet cannot see the master key.
 *
 * Plain `DurableObject` (not a Nebula mesh DO): this is a test fixture standing
 * in for the parent DO, not platform logic. See tasks/spike-outside-world-secrets.md.
 */
import { DurableObject } from 'cloudflare:workers';
import {
  importVaultKey,
  sealSecret,
  resolveSecret,
  type SecretMode,
  type VaultLevel,
} from '../../spike-secrets-vault/vault';

const KEY_VAR = 'NEBULA_SECRETS_KEY';

/**
 * Facet module source — a DO class loaded via the Worker Loader. It reads ONLY
 * its injected `env`, proving both the injection channel and isolation from the
 * master key (which is deliberately never injected).
 */
const FACET_MODULE = `
import { DurableObject } from 'cloudflare:workers';
export class SecretEcho extends DurableObject {
  async prove() {
    const injected = this.env.RESOLVED_SECRET;
    const has = typeof injected === 'string';
    let sha256 = null;
    if (has) {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(injected));
      sha256 = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
    }
    return {
      has,
      length: has ? injected.length : 0,
      sha256,
      masterKeyVisible: this.env.${KEY_VAR} !== undefined,
      envKeys: Object.keys(this.env).sort(),
    };
  }
}
`;

interface FacetProof {
  has: boolean;
  length: number;
  sha256: string | null;
  masterKeyVisible: boolean;
  envKeys: string[];
}

interface SecretEchoFacet {
  prove(): Promise<FacetProof>;
}

export class SecretBrokerDO extends DurableObject {
  async #key(): Promise<CryptoKey> {
    const b64 = (this.env as unknown as Record<string, unknown>)[KEY_VAR] as string;
    const bin = atob(b64);
    const raw = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) raw[i] = bin.charCodeAt(i);
    return importVaultKey(raw);
  }

  /** Seal `plaintext` into the mock `level` vault (this DO's KV). */
  async seedSecret(level: 'star' | 'galaxy', name: string, plaintext: string): Promise<void> {
    const sealed = await sealSecret(await this.#key(), plaintext);
    this.ctx.storage.kv.put(`vault:${level}:${name}`, sealed);
  }

  /** Resolve `name` per `mode`, inject the plaintext into a throwaway facet, and
   *  return the facet's self-report. */
  async runFacet(name: string, mode: SecretMode): Promise<FacetProof> {
    const key = await this.#key();
    const levelGet = (level: 'star' | 'galaxy'): VaultLevel => ({
      get: (n) => this.ctx.storage.kv.get<string>(`vault:${level}:${n}`) ?? undefined,
    });
    const plaintext = await resolveSecret(name, mode, key, {
      star: levelGet('star'),
      galaxy: levelGet('galaxy'),
    });
    return this.#facet(plaintext).prove();
  }

  /** Every KV value at rest — for the no-plaintext-at-rest assertion. */
  dumpStorage(): string[] {
    const out: string[] = [];
    for (const [, value] of this.ctx.storage.kv.list<string>()) out.push(value);
    return out;
  }

  #facet(resolved: string | undefined): SecretEchoFacet {
    // Unique bundleId per call: the injected env is captured at cold load, so a
    // reused id would pin the first injection (loader caches by bundleId
    // per-Worker — durable-objects.md § Dynamic Worker Loader cache).
    const bundleId = `secret-echo:${crypto.randomUUID()}`;
    const stub = this.ctx.facets.get(bundleId, () => {
      const worker = this.env.LOADER.get(bundleId, () => ({
        compatibilityDate: '2026-04-01',
        mainModule: 'echo.js',
        modules: { 'echo.js': FACET_MODULE },
        // ONLY the resolved secret — NOT NEBULA_SECRETS_KEY, NOT LOADER, nothing else.
        env: { RESOLVED_SECRET: resolved },
        globalOutbound: null,
      }));
      return { class: worker.getDurableObjectClass('SecretEcho') };
    });
    return stub as unknown as SecretEchoFacet;
  }
}

export default {
  fetch(): Response {
    return new Response('secrets-facet spike harness');
  },
};
