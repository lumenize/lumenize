/**
 * Spike test-app entrypoint.
 *
 * Re-exports production DO classes (Star, Galaxy, etc.) from `@lumenize/nebula`
 * unchanged; the spike's reshape only touches the client side. Tests
 * instantiate `NebulaClient` from `../src/nebula-client` directly — no DO
 * binding needed for the client class.
 */

// Production DOs + entrypoint
export {
  NebulaClientGateway,
  Universe,
  Galaxy,
  Star,
  ResourceHistory,
  entrypoint as default,
} from '@lumenize/nebula';

// Production auth classes
export { NebulaAuth, NebulaAuthRegistry, NebulaEmailSender } from '@lumenize/nebula-auth';
