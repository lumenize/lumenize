import * as sourceModule from './test-dos';
import { instrumentDOProject } from '@lumenize/testing';

const instrumented = instrumentDOProject({
  sourceModule,
  doClassNames: ['OriginDO', 'RemoteDO']
});

export const { OriginDO, RemoteDO } = instrumented.dos;
export default instrumented;

