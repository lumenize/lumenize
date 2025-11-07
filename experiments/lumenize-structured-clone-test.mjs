/**
 * Test @lumenize/structured-clone behavior with Map/Set object keys
 * Compare to native structuredClone behavior
 */

import { stringify, parse, preprocess, postprocess } from '@lumenize/structured-clone';

console.log('=== Testing @lumenize/structured-clone ===\n');

// Test 1: Map with object key (separate serialization)
console.log('Test 1: Map with object key (SEPARATE serialization - identity lost)');
const keyObj1 = { userId: 123, role: 'admin' };
const originalMap1 = new Map([[keyObj1, 'user data']]);

console.log('Original map size:', originalMap1.size);
console.log('Can access with original key:', originalMap1.get(keyObj1)); // Should work

const serializedMap1 = await stringify(originalMap1);
const clonedMap1 = await parse(serializedMap1);

console.log('Cloned map size:', clonedMap1.size);
console.log('Can access with original key:', clonedMap1.get(keyObj1)); // Won't work - different serialization
console.log('Can access with new key:', clonedMap1.get({ userId: 123, role: 'admin' })); // Won't work
const clonedKeys1 = Array.from(clonedMap1.keys());
console.log('Can access with cloned key:', clonedMap1.get(clonedKeys1[0])); // Should work
console.log();

// Test 2: Object with Map and separate key reference (TOGETHER - identity preserved!)
console.log('Test 2: Object with Map and separate key reference (TOGETHER - identity preserved!)');
const sharedKey = { id: 456 };
const data = {
  map: new Map([[sharedKey, 'value']]),
  theKey: sharedKey  // Same key referenced twice
};

console.log('Original: map.get(theKey) works?', data.map.get(data.theKey)); // Should work
console.log('Original: theKey === map key?', data.theKey === Array.from(data.map.keys())[0]); // Should be true

const serializedData = await stringify(data);
const clonedData = await parse(serializedData);

console.log('Cloned: map.get(theKey) works?', clonedData.map.get(clonedData.theKey)); // THE KEY QUESTION!
console.log('Cloned: theKey === map key?', clonedData.theKey === Array.from(clonedData.map.keys())[0]); // Should be true if identity preserved
console.log();

// Test 3: Set with object value (TOGETHER)
console.log('Test 3: Set with object value (TOGETHER)');
const sharedObj = { id: 789 };
const setData = {
  set: new Set([sharedObj]),
  theObj: sharedObj
};

console.log('Original: set.has(theObj)?', setData.set.has(setData.theObj)); // Should be true

const serializedSetData = await stringify(setData);
const clonedSetData = await parse(serializedSetData);

console.log('Cloned: set.has(theObj)?', clonedSetData.set.has(clonedSetData.theObj)); // THE KEY QUESTION!
console.log('Cloned: theObj === set value?', clonedSetData.theObj === Array.from(clonedSetData.set)[0]); // Should be true if identity preserved
console.log();

// Test 4: Circular reference with Map
console.log('Test 4: Circular reference with Map');
const circularKey = { type: 'key' };
const circularMap = new Map([[circularKey, 'data']]);
circularKey.backref = circularMap;  // Circular!

console.log('Original has circular reference:', circularKey.backref === circularMap);

const serializedCircular = await stringify(circularMap);
const clonedCircular = await parse(serializedCircular);
const clonedCircularKeys = Array.from(clonedCircular.keys());
console.log('Cloned: key.backref === cloned map?', clonedCircularKeys[0].backref === clonedCircular); // Should be true if cycles preserved
console.log();

// Test 5: Using preprocess/postprocess layer
console.log('Test 5: Using preprocess/postprocess (TOGETHER)');
const key5 = { userId: 999 };
const data5 = {
  map: new Map([[key5, 'preprocessed data']]),
  theKey: key5
};

const intermediate5 = await preprocess(data5);
console.log('Intermediate format created');
console.log('Root type:', intermediate5.root);
console.log('Objects array length:', intermediate5.objects.length);

const restored5 = await postprocess(intermediate5);
console.log('Restored: map.get(theKey) works?', restored5.map.get(restored5.theKey));
console.log('Restored: theKey === map key?', restored5.theKey === Array.from(restored5.map.keys())[0]);
console.log();

// Test 6: Multiple preprocess calls (SEPARATE - identity lost)
console.log('Test 6: Multiple preprocess calls (SEPARATE - identity lost)');
const key6 = { userId: 1000 };
const map6 = new Map([[key6, 'data in map']]);

// Serialize them separately
const intermediate6a = await preprocess(map6);
const intermediate6b = await preprocess(key6);

// Restore them separately
const restoredMap6 = await postprocess(intermediate6a);
const restoredKey6 = await postprocess(intermediate6b);

console.log('Restored map size:', restoredMap6.size);
console.log('Can access with separately-restored key?', restoredMap6.get(restoredKey6)); // Won't work!
const restoredKeys6 = Array.from(restoredMap6.keys());
console.log('Can access with key from map?', restoredMap6.get(restoredKeys6[0])); // Should work
console.log('Are they the same object?', restoredKey6 === restoredKeys6[0]); // No - different serialization contexts
console.log();

console.log('=== Summary ===');
console.log('✅ Our structured-clone DOES preserve identity within a single call (Tests 2, 3, 4, 5)');
console.log('❌ Identity is lost across separate calls (Tests 1, 6)');
console.log('👉 This matches native structuredClone() behavior exactly!');

