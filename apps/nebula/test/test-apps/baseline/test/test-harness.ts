import * as sourceModule from '../index';
import { instrumentDOProject } from '@lumenize/testing';

const instrumented = instrumentDOProject(sourceModule);

// Wrangler requires DO classes as named exports.
export const {
  NebulaClientGateway,
  Universe,
  GalaxyTest,
  StarTest,
  NebulaAuthRegistry,
  NebulaClientTest,
  ProfileTest,
} = instrumented.dos;

// Non-DO classes are passed through unwrapped
export const { NebulaEmailSender, NebulaAuthFacade, PlatformHost } = instrumented;

export default instrumented;
