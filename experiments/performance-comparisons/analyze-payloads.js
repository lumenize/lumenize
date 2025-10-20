// Quick script to analyze payload sizes
import { stringify } from '@ungap/structured-clone/json';

// Simulate real requests from our tests
const incrementRequest = {
  id: "test-id-123456",
  type: "lumenize-rpc",
  operations: [
    { type: "get", key: "increment" },
    { type: "apply", args: [1] }
  ]
};

const getValueRequest = {
  id: "test-id-123456",
  type: "lumenize-rpc",
  operations: [
    { type: "get", key: "getValue" },
    { type: "apply", args: [] }
  ]
};

const successResponse = {
  id: "test-id-123456",
  type: "lumenize-rpc",
  success: true,
  result: 42
};

const incReq = stringify(incrementRequest);
const getReq = stringify(getValueRequest);
const response = stringify(successResponse);

console.log('=== Lumenize RPC Payload Analysis ===\n');
console.log(`increment() request: ${incReq.length} bytes`);
console.log(`getValue() request: ${getReq.length} bytes`);
console.log(`Success response: ${response.length} bytes`);
console.log(`\nincrement() round-trip: ${incReq.length + response.length} bytes`);
console.log(`getValue() round-trip: ${getReq.length + response.length} bytes`);

console.log('\n=== Actual JSON ===\n');
console.log('increment() request:');
console.log(incReq);
console.log('\ngetValue() request:');
console.log(getReq);
console.log('\nResponse:');
console.log(response);
