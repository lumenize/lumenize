import { MyDO as Original_MyDO, default as original_worker } from '../src';
import { instrumentDO, instrumentWorker } from '@lumenize/testing';

// We need both instrumentDO (for __testing/ctx endpoint) and instrumentWorker (for env instrumentation)
// instrumentWorker ensures that DO bindings are properly tracked during Worker execution
const MyDO = instrumentDO(Original_MyDO);
const worker = instrumentWorker(original_worker as any); // Type assertion to work around Cloudflare types

export { MyDO };
export default worker;
