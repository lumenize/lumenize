import { MyDO as Original_MyDO, default as original_worker } from '../src';
import { instrumentDO, instrumentWorker } from '@lumenize/testing';

const MyDO = instrumentDO(Original_MyDO);
const worker = instrumentWorker(original_worker);

export { MyDO };
export default worker;
