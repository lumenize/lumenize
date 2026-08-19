import * as sourceModule from '../index';
import { instrumentDOProject } from '@lumenize/testing';

const instrumented = instrumentDOProject(sourceModule);

// Wrangler requires DO classes as named exports.
export const {
  NebulaClientGateway,
  Universe,
  Galaxy,
  StarTest,
  DevStudioTest,
  DevContainerServeStub,
  NebulaAuthRegistry,
  NebulaClientTest,
  ProfileTest,
} = instrumented.dos;

// Non-DO classes are passed through unwrapped
export const { NebulaEmailSender, NebulaAuthFacade } = instrumented;

export default instrumented;
