# Lumenize UI

**Status**: Not Started

## Goal

Build a UI framework package (`@lumenize/ui`) for Lumenize Mesh applications.

## Design Notes

### Avoiding UI Flicker on Resource Updates

Lumenize Mesh returns a full `Snapshot<T>` (with `value` and `meta`) on every read and subscribe — the framework performs no conditional checking on the read/subscribe path. `meta.eTag` is included so callers can use it for subsequent upserts, but reads always return the full snapshot.

This means the UI layer is responsible for avoiding unnecessary re-renders when the incoming value hasn't actually changed. Two approaches:

1. **Local eTag comparison** — compare `snapshot.meta.eTag` against the last-seen eTag before updating the DOM. If they match, skip the update.
2. **Deep object change detection** — compare `snapshot.value` against the current value before updating.

Either approach prevents flicker when a subscribe handler fires but the value is unchanged (e.g., after reconnection replay). This is noted in `tasks/mesh-resources.md` (Snapshot Response Shape section) as a strong argument for UI-layer handling.
