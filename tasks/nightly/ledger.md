# Nightly-pass ledger

One line per nightly run — a quick history of what the v1 audit pass did each night (tripwire result + mutation-audit progress). Appended by the skill; hand-edit freely. Per-audit **cursors** and finding **dedup** live in `audit-state.md`, not here.

Format: `- <date> · tripwires <✅|⚠️N> · mutation-audit <k checked, m findings> · <audited>/<corpus>`

<!-- runs below, newest at bottom -->
- 2026-06-14 · backlog #5 Mn9 collection-entry-interior probe captured in §5.3.8 · ⚠️1 finding (probe absent — proposed add to §5.3.8) · DRY RUN
