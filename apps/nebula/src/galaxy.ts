/**
 * Galaxy — singleton per galaxy (e.g., instanceName = "acme.app")
 */

import { mesh } from '@lumenize/mesh';
import { NebulaDO, requireAdmin } from './nebula-do';
import { Ontology } from './ontology';
import type { OntologyVersionConfig } from './ontology';

export class Galaxy extends NebulaDO {
  @mesh(requireAdmin)
  setGalaxyConfig(key: string, value: unknown) {
    const config = this.ctx.storage.kv.get<Record<string, unknown>>('config') ?? {};
    config[key] = value;
    this.ctx.storage.kv.put('config', config);
  }

  @mesh()
  getGalaxyConfig(): Record<string, unknown> {
    return this.ctx.storage.kv.get<Record<string, unknown>>('config') ?? {};
  }

  /** Append a new version — validates eagerly, appends to stored array */
  @mesh(requireAdmin)
  appendOntologyVersion(versionConfig: OntologyVersionConfig) {
    const stored = this.ctx.storage.kv.get<OntologyVersionConfig[]>('ontology') ?? [];

    // Duplicate version label check
    if (stored.some(v => v.version === versionConfig.version)) {
      throw new Error(`Ontology version '${versionConfig.version}' already exists — versions are append-only`);
    }

    // Validate eagerly: construct Ontology to catch parse errors in type definitions
    const updated = [...stored, versionConfig];
    new Ontology(updated);

    this.ctx.storage.kv.put('ontology', updated);
  }

  /** Return the full ontology config array — called by Stars on cache miss */
  @mesh()
  getOntology(): OntologyVersionConfig[] {
    return this.ctx.storage.kv.get<OntologyVersionConfig[]>('ontology') ?? [];
  }
}
