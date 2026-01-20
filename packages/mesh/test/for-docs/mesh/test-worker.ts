/**
 * Minimal test worker for getting-started.mdx examples
 *
 * This implements the collaborative document editor from the docs:
 * - DocumentDO: stores content, notifies subscribers, triggers spell check
 * - SpellCheckWorker: stateless worker that checks spelling
 * - LumenizeClientGateway: re-exported from @lumenize/mesh
 */

import { LumenizeDO, LumenizeWorker, mesh, LumenizeClientGateway } from '../../../src/index.js';
import { routeDORequest } from '@lumenize/utils';
import { createWebSocketAuthMiddleware, createAuthMiddleware } from '@lumenize/auth';

// Note: The continuation type system uses runtime proxies that TypeScript doesn't fully understand.
// We use 'any' casts where necessary since runtime behavior is correct.

// Re-export Gateway for wrangler bindings
export { LumenizeClientGateway };

// ============================================
// SpellCheckWorker - stateless spelling checker
// ============================================

export interface SpellFinding {
  word: string;
  position: number;
  suggestions: string[];
}

export class SpellCheckWorker extends LumenizeWorker<Env> {
  @mesh
  check(content: string): SpellFinding[] {
    // Mock implementation - in real app this would call external API
    // For testing, we'll flag any word containing "teh" as a typo
    const findings: SpellFinding[] = [];
    const words = content.split(/\s+/);
    let position = 0;

    for (const word of words) {
      if (word.toLowerCase().includes('teh')) {
        findings.push({
          word,
          position,
          suggestions: [word.replaceAll(/teh/gi, 'the')]
        });
      }
      position += word.length + 1; // +1 for space
    }

    return findings;
  }
}

// ============================================
// DocumentDO - collaborative document storage
// ============================================

// TODO: Remove this forward declare EditorClient once we have written it and can import it
interface EditorClient {
  handleContentUpdate(content: string): void;
  handleSpellFindings(findings: SpellFinding[]): void;
}

export class DocumentDO extends LumenizeDO<Env> {
  // Require authentication for all mesh calls
  onBeforeCall(): void {
    super.onBeforeCall();
    if (!this.lmz.callContext.originAuth?.userId) {
      throw new Error('Authentication required');
    }
  }

  @mesh
  update(content: string) {
    this.ctx.storage.kv.put('content', content);

    // Notify all subscribers with new content
    this.#broadcastContent(content);

    // Trigger spell check (fire-and-forget with callback)
    const remote = this.ctn<SpellCheckWorker>().check(content);
    this.lmz.call(
      'SPELLCHECK_WORKER',
      undefined,
      remote,
      this.ctn().handleSpellCheckResult(remote)
    );
  }

  @mesh
  subscribe(): string {
    const { callChain } = this.lmz.callContext;
    const clientId = callChain.at(-1)?.instanceName;
    if (clientId) {
      const subscribers: Set<string> = this.ctx.storage.kv.get('subscribers') ?? new Set();
      subscribers.add(clientId);
      this.ctx.storage.kv.put('subscribers', subscribers);
    }
    return this.ctx.storage.kv.get('content') ?? '';
  }

  @mesh
  unsubscribe() {
    const { callChain } = this.lmz.callContext;
    const clientId = callChain.at(-1)?.instanceName;
    if (clientId) {
      const subscribers: Set<string> = this.ctx.storage.kv.get('subscribers') ?? new Set();
      subscribers.delete(clientId);
      this.ctx.storage.kv.put('subscribers', subscribers);
    }
  }

  // Response handler - no @mesh needed (framework trusts own continuations)
  handleSpellCheckResult(findings: SpellFinding[] | Error) {
    if (findings instanceof Error) {
      console.error('Spell check failed:', findings);
      return;
    }
    this.#broadcastSpellFindings(findings);
  }

  #broadcastContent(content: string) {
    const subscribers: Set<string> = this.ctx.storage.kv.get('subscribers') ?? new Set();
    for (const clientId of subscribers) {
      const remote = this.ctn<EditorClient>().handleContentUpdate(content);
      this.lmz.call(
        'LUMENIZE_CLIENT_GATEWAY',
        clientId,
        remote
      );
    }
  }

  #broadcastSpellFindings(findings: SpellFinding[]) {
    const subscribers: Set<string> = this.ctx.storage.kv.get('subscribers') ?? new Set();
    for (const clientId of subscribers) {
      const remote = this.ctn<EditorClient>().handleSpellFindings(findings);
      this.lmz.call(
        'LUMENIZE_CLIENT_GATEWAY',
        clientId,
        remote
      );
    }
  }

  // Test helpers
  @mesh
  getSubscribers(): string[] {
    const subscribers: Set<string> = this.ctx.storage.kv.get('subscribers') ?? new Set();
    return Array.from(subscribers);
  }

  @mesh
  getContent(): string {
    return this.ctx.storage.kv.get('content') ?? '';
  }
}

// ============================================
// Worker Entry Point
// ============================================

export default {
  async fetch(request: Request, env: Env) {
    // Get public keys from env
    const publicKeys = [env.JWT_PUBLIC_KEY_BLUE, env.JWT_PUBLIC_KEY_GREEN].filter(Boolean);

    // Create auth middleware for WebSocket and HTTP requests
    const wsAuth = await createWebSocketAuthMiddleware({ publicKeysPem: publicKeys });
    const httpAuth = await createAuthMiddleware({ publicKeysPem: publicKeys });

    const response = await routeDORequest(request, env, {
      prefix: 'gateway',
      onBeforeConnect: wsAuth,
      onBeforeRequest: httpAuth,
    });

    if (response) {
      return response;
    }

    return new Response('Not Found', { status: 404 });
  },
};
