# Phase 5.2: tsc Validation in DWL

**Status**: Pending
**Depends on**: Phase 5.1 (Storage Engine)
**ADR**: `docs/adr/001-typescript-as-schema.md`

## Scope

Bundle tsc in a DWL isolate. Validate data against TypeScript type definitions before write. Simple service call — no base class, no guard dispatch. Operationalizes ADR-001.
