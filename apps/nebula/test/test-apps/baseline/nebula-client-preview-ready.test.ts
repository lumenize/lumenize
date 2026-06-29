/**
 * Preview auto-refresh — tasks/preview-ready-autorefresh.md
 *
 * `NebulaClient.warmPreview()` fires a one-way request at DevStudio (passing its own
 * `instanceName`); when the dev preview is serving, DevStudio delivers a
 * `handlePreviewReady(scope)` push back (direct delivery by `instanceName`), and the
 * client invokes the `onPreviewReady` hook so the UI auto-refreshes the iframe — no
 * manual Reload, no polling.
 *
 * The real warm flow needs `env.AI`-free DevStudio + a live container (the `ui-smoke`
 * lane). Here we drive the mechanism through the full client↔Gateway↔DO path with a
 * stand-in: `StarTest.runFakePreviewWarm` echoes `handlePreviewReady` exactly as
 * `DevStudio.deliverPreviewReady` would (same `lmz.call('NEBULA_CLIENT_GATEWAY',
 * clientId, ctn().handlePreviewReady(scope))` shape). The reconnect-survival of this
 * delivery shape is already proven generically by `nebula-client-chat-delivery.test.ts`.
 *
 * Mutation-validated (testing.md): commenting out `this.#onPreviewReady?.(scope)` in
 * `NebulaClient.handlePreviewReady` leaves `captured` empty → the `vi.waitFor` times
 * out → this test reddens.
 */
import { describe, it, expect, vi } from 'vitest';
import { Browser } from '@lumenize/testing';
import { generateUuid } from '@lumenize/auth';
import { createAuthenticatedClient } from '../../test-helpers';
import { NebulaClientTest } from './index';

function uniqueStar(): string {
  return `acme-${generateUuid().slice(0, 8)}.app.tenant-a`;
}

describe('nebula-client preview-ready auto-refresh', () => {

  it('warmPreview round-trips: handlePreviewReady invokes onPreviewReady by scope', async () => {
    const star = uniqueStar();
    const captured: string[] = [];
    const a = await createAuthenticatedClient(
      NebulaClientTest, new Browser(), star, star, 'admin@example.com', 'v1',
      { onPreviewReady: (scope: string) => { captured.push(scope); } },
    );

    a.client.warmPreviewViaStarForTest(star);

    // The stand-in echoes handlePreviewReady(scope=star) → onPreviewReady hook fires.
    await vi.waitFor(() => { expect(captured).toContain(star); });
  });

});
