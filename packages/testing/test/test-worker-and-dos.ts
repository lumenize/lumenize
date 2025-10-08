import * as sourceModule from './test-do';
import { instrumentDOProject } from '../src/instrument-do-project';

const { worker, dos } = instrumentDOProject({
  sourceModule,
  doClassNames: ['TestDO']
});

export const { TestDO: TestDOWithRpc } = dos;
export default worker;
