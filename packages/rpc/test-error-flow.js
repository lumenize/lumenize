// Quick test to check Error flow
import { stringify, parse } from '@lumenize/structured-clone';

const error = new Error('Test');
error.name = 'CustomError';
error.code = 'TEST_CODE';

console.log('Original:', error);
console.log('Original instanceof Error:', error instanceof Error);
console.log('Original proto:', Object.getPrototypeOf(error));

const serialized = await stringify(error);
console.log('\nSerialized:', serialized);

const deserialized = await parse(serialized);
console.log('\nDeserialized:', deserialized);
console.log('Deserialized instanceof Error:', deserialized instanceof Error);
console.log('Deserialized proto:', Object.getPrototypeOf(deserialized));
console.log('Deserialized.name:', deserialized.name);
console.log('Deserialized.code:', deserialized.code);
