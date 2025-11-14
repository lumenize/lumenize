/**
 * Call Patterns Measurements
 */

import { runAllExperiments } from '@lumenize/for-experiments/node-client';

const BASE_URL = process.env.TEST_URL || 'http://localhost:8787';
const OPS_COUNT = parseInt(process.argv[2] || '50', 10);
const REVERSE = process.argv[3] === 'reverse';

runAllExperiments(BASE_URL, OPS_COUNT, { reverse: REVERSE })
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
