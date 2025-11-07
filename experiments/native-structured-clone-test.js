/**
 * Test native structuredClone() behavior with Map/Set object keys
 */

console.log('=== Testing Native structuredClone() ===\n');

// Test 1: Map with object key
console.log('Test 1: Map with object key');
const keyObj = { userId: 123, role: 'admin' };
const originalMap = new Map([[keyObj, 'user data']]);

console.log('Original map size:', originalMap.size);
console.log('Can access with original key:', originalMap.get(keyObj)); // Should work

const clonedMap = structuredClone(originalMap);

console.log('Cloned map size:', clonedMap.size);
console.log('Can access with original key:', clonedMap.get(keyObj)); // Will this work?
console.log('Can access with new key:', clonedMap.get({ userId: 123, role: 'admin' })); // Probably not
const clonedKeys = Array.from(clonedMap.keys());
console.log('Can access with cloned key:', clonedMap.get(clonedKeys[0])); // Should work
console.log('Are keys the same reference?', clonedKeys[0] === keyObj); // Definitely not
console.log();

// Test 2: Object with Map and separate key reference
console.log('Test 2: Object with Map and separate key reference');
const sharedKey = { id: 456 };
const data = {
  map: new Map([[sharedKey, 'value']]),
  theKey: sharedKey  // Same key referenced twice
};

console.log('Original: map.get(theKey) works?', data.map.get(data.theKey)); // Should work
console.log('Original: theKey === map key?', data.theKey === Array.from(data.map.keys())[0]); // Should be true

const clonedData = structuredClone(data);

console.log('Cloned: map.get(theKey) works?', clonedData.map.get(clonedData.theKey)); // THE KEY QUESTION!
console.log('Cloned: theKey === map key?', clonedData.theKey === Array.from(clonedData.map.keys())[0]); // Should be true if identity preserved
console.log();

// Test 3: Set with object value
console.log('Test 3: Set with object value');
const sharedObj = { id: 789 };
const setData = {
  set: new Set([sharedObj]),
  theObj: sharedObj
};

console.log('Original: set.has(theObj)?', setData.set.has(setData.theObj)); // Should be true

const clonedSetData = structuredClone(setData);

console.log('Cloned: set.has(theObj)?', clonedSetData.set.has(clonedSetData.theObj)); // THE KEY QUESTION!
console.log('Cloned: theObj === set value?', clonedSetData.theObj === Array.from(clonedSetData.set)[0]); // Should be true if identity preserved
console.log();

// Test 4: Circular reference with Map
console.log('Test 4: Circular reference with Map');
const circularKey = { type: 'key' };
const circularMap = new Map([[circularKey, 'data']]);
circularKey.backref = circularMap;  // Circular!

console.log('Original has circular reference:', circularKey.backref === circularMap);

const clonedCircular = structuredClone(circularMap);
const clonedCircularKeys = Array.from(clonedCircular.keys());
console.log('Cloned: key.backref === cloned map?', clonedCircularKeys[0].backref === clonedCircular); // Should be true if cycles preserved

console.log('\n=== Summary ===');
console.log('Native structuredClone DOES preserve identity within a single call!');
console.log('Now let\'s test if our @lumenize/structured-clone does the same...');

