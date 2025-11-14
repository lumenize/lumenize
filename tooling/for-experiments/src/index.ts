/**
 * @lumenize/for-experiments
 * 
 * Reusable tooling for production experiments on Cloudflare Workers
 */

export { 
  ExperimentController,
  type VariationDefinition 
} from './controller.js';
export { runBatch, connectWebSocket, displayResults, runAllExperiments } from './node-client.js';

