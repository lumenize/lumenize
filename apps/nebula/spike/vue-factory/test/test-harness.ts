import * as sourceModule from './index';
import { instrumentDOProject } from '@lumenize/testing';

const instrumented = instrumentDOProject(sourceModule);

export const {
  NebulaClientGateway,
  Universe,
  Galaxy,
  Star,
  ResourceHistory,
  NebulaAuth,
  NebulaAuthRegistry,
} = instrumented.dos;

export const { NebulaEmailSender } = instrumented;

export default instrumented;
