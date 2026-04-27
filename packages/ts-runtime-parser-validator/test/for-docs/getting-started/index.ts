/**
 * Worker entry point for getting-started.md examples.
 *
 * Exports the `SupervisorDO` class from the doc verbatim so the doc's code
 * block substring-matches this file's contents after normalisation.
 */

import { DurableObject } from 'cloudflare:workers';
import {
  getParserValidatorFacet,
  type ParseResult,
} from '../../../src/facet-helper';

export class SupervisorDO extends DurableObject<Env> {
  async parse(bundleId: string, value: unknown, typeName: string): Promise<ParseResult> {
    const facet = getParserValidatorFacet(
      this.ctx,
      this.env.LOADER,
      bundleId,
      () => this.ctx.storage.kv.get(`parser:${bundleId}`) as string,
    );
    return await facet.parse(value, typeName);
  }

  registerModuleSource(bundleId: string, moduleSource: string) {
    this.ctx.storage.kv.put(`parser:${bundleId}`, moduleSource);
  }
}

export default {
  async fetch(): Promise<Response> {
    return new Response('ok');
  },
};
