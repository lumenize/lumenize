# Ontology Research

External material relevant to Nebula's ontology vision — competitor analysis, framework critiques, standards background. Add new entries at the top.

---

## 2026-05-03 — Google vs Microsoft vs Palantir: The Enterprise Ontology Race

**Pankaj Kumar**, Medium. https://medium.com/@cloudpankaj/google-vs-microsoft-vs-palantir-the-enterprise-ontology-race-and-the-layer-all-three-are-missing-e965b2d635d9 (paywalled)

Companion repo (public): https://github.com/cloudbadal007/owl-portability-layer
Predecessor (also paywalled, mirrored at https://towardsai.net/p/machine-learning/microsoft-vs-palantir-two-paths-to-enterprise-ontology-and-why-microsofts-bet-on-semantic-contracts-changes-the-game): "Microsoft vs Palantir: Two Paths to Enterprise Ontology" (56K views per the author).

**Author's framework.** Splits "enterprise ontology" into two layers: (1) *retrieval/grounding* — entities, relationships, semantic context for agents (where all three giants are competing); (2) *enforcement* — declarative business-rule constraints that prevent semantically-valid-but-contextually-wrong decisions. Claim: none of the three ships layer 2, and that's the headline gap. Running example: `ComplianceHold cannot be released without a Legal approver` — every vendor can *tell* an LLM the rule, none can *block* the action when violated.

**Vendor strengths the author concedes:**
- Google: auto-generates semantics from docs/queries via Gemini; entity reconciliation at planetary scale (Search-grade MIDs); only open standard alignment (RDF/JSON-LD via Enterprise Knowledge Graph); MCP exposure.
- Microsoft Fabric IQ: most sophisticated **agent permission model** ("permitted actions" — what an agent may read/write/respect); natural evolution path from existing Power BI semantic models.
- Palantir Foundry: production-grade **write-back governance** — `Action Types` with approval chains, dual approvals, machine-readable audit trails. The article's clearest "this is what makes it an ontology" exemplar.

**Relevance to Nebula:**
- The two-layer split maps cleanly onto where Nebula sits: shape validation via typia gives us layer 1 partially, but the declarative business-rule layer + introspectable schema are missing.
- Action Types (Palantir) is the single primitive most cited as the schema/ontology dividing line. Nebula's generic `resources.transaction()` is the equivalent of unstructured patches; promoting to named verbs with declared pre/post-conditions is the cheapest way to claim the word "ontology."
- The author's "portability" framing (vendor-neutral OWL/SHACL substrate with platform adapters) is a *mechanism*, not the core thesis. Nebula isn't positioned as portability-first, so the constituent-parts checklist matters more than the OWL serialization story.
- `ComplianceHold` example is a useful litmus test for documentation: can we encode it declaratively today? No (only as imperative checks in handler code). That gap is concrete and demoable.

**Worth following from this author:**
- The Enterprise AI Ontology Roadmap (30+ article index): https://medium.com/@cloudpankaj/the-enterprise-ai-ontology-roadmap-30-articles-4-learning-tracks-and-where-to-start-22efc17bb026
- "Palantir Foundry Ontology: How It Works, What Problems It Solves" — drills into the three-layer model.
