/**
 * Final verification: the original failing case — full @lumenize/nebula
 * import, which is what `apps/nebula/test/browser/worker/index.ts` does.
 */

export {
  NebulaClientGateway,
  Universe,
  Galaxy,
  ResourceHistory,
  entrypoint as default,
} from '@lumenize/nebula';
