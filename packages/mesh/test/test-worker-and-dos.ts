// Import NADIS packages to register services
import '@lumenize/alarms';

import { LumenizeDO } from '../src/lumenize-do';
import { LumenizeWorker } from '../src/lumenize-worker';
import { mesh } from '../src/mesh-decorator';
import type { CallEnvelope } from '../src/lmz-api';
import type { Schedule } from '@lumenize/alarms';
import { getOperationChain } from '../src/ocan/index.js';
import { preprocess } from '@lumenize/structured-clone';

// Export LumenizeClientGateway for testing
export { LumenizeClientGateway } from '../src/lumenize-client-gateway';

// Export documentation example DOs
export { UsersDO, NotificationsDO } from './for-docs/lumenize-do/basic-usage.test';

// Export test DO for NadisPlugin tests
export { NadisPluginTestDO } from './nadis-plugin-test-do';

export class TestDO extends LumenizeDO<Env> {
  executedAlarms: Array<{ payload: any; schedule: Schedule }> = [];

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Run migrations in constructor (recommended pattern)
    this.#initTable();
  }

  // Required: delegate to Alarms
  async alarm() {
    await this.svc.alarms.alarm();
  }

  // Migration: Create users table
  #initTable() {
    this.svc.sql`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT,
        age INTEGER
      )
    `;
  }

  // Test helper: Insert a user using sql
  insertUser(id: string, name: string, age: number) {
    this.svc.sql`
      INSERT INTO users (id, name, age)
      VALUES (${id}, ${name}, ${age})
    `;
  }

  // Test helper: Get user by ID using sql
  getUserById(id: string) {
    const rows = this.svc.sql`SELECT * FROM users WHERE id = ${id}`;
    return rows[0];
  }

  // Test helper: Schedule an alarm using alarms
  async scheduleAlarm(when: Date | string | number, payload?: any) {
    return await this.svc.alarms.schedule(when, this.ctn().handleAlarm(payload));
  }

  // Test helper: Get a schedule by ID
  async getSchedule(id: string) {
    return await this.svc.alarms.getSchedule(id);
  }

  // Test helper: Cancel a schedule
  async cancelSchedule(id: string) {
    return await this.svc.alarms.cancelSchedule(id);
  }

  // Alarm callback - receives schedule as first parameter (injected by alarms)
  async handleAlarm(schedule: Schedule, payload: any) {
    this.executedAlarms.push({ payload, schedule });
  }

  // Test helper: Get executed alarms
  async getExecutedAlarms() {
    return this.executedAlarms;
  }

  // Test helper: Access non-existent service to trigger error
  async accessNonExistentService() {
    // @ts-expect-error - Intentionally accessing non-existent service
    return this.svc.nonExistent;
  }

  // Test helpers for this.lmz.init() - now obsolete, tests use this.lmz.init() directly

  async getStoredBindingName() {
    return this.ctx.storage.kv.get('__lmz_do_binding_name');
  }

  async getStoredInstanceName() {
    return this.ctx.storage.kv.get('__lmz_do_instance_name');
  }

  async clearStoredMetadata() {
    this.ctx.storage.kv.delete('__lmz_do_binding_name');
    this.ctx.storage.kv.delete('__lmz_do_instance_name');
  }

  // Test helper for fetch() with custom headers
  async testFetch(headers: Record<string, string> = {}) {
    const request = new Request('https://example.com', { headers });
    return await this.fetch(request);
  }

  // Test helpers for this.lmz.* API
  async testLmzType() {
    return this.lmz.type;
  }

  async testLmzGetBindingName() {
    return this.lmz.bindingName;
  }

  async testLmzSetBindingName(value: string) {
    this.lmz.bindingName = value;
  }

  async testLmzGetInstanceName() {
    return this.lmz.instanceName;
  }

  async testLmzSetInstanceName(value: string) {
    this.lmz.instanceName = value;
  }

  async testLmzGetId() {
    return this.lmz.id;
  }

  async testLmzSetId(value: string) {
    this.lmz.id = value;
  }

  async testLmzGetInstanceNameOrId() {
    return this.lmz.instanceNameOrId;
  }

  async testLmzSetInstanceNameOrId(value: string) {
    this.lmz.instanceNameOrId = value;
  }

  async testLmzApiInit(options?: { bindingName?: string; instanceNameOrId?: string }) {
    this.lmz.init(options);
  }

  // Test helpers for this.lmz.callRaw()
  async testCallRawWithContinuation(
    calleeBindingName: string,
    calleeInstanceNameOrId: string | undefined,
    value: string
  ) {
    return await this.lmz.callRaw(
      calleeBindingName,
      calleeInstanceNameOrId,
      this.ctn<TestDO>().remoteEcho(value)
    );
  }

  async testCallRawWithOperationChain(
    calleeBindingName: string,
    calleeInstanceNameOrId: string | undefined,
    chain: any
  ) {
    return await this.lmz.callRaw(
      calleeBindingName,
      calleeInstanceNameOrId,
      chain
    );
  }

  // Remote method that can be called via RPC
  @mesh
  remoteEcho(value: string): string {
    return `echo: ${value}`;
  }

  // Remote method that returns caller identity
  @mesh
  getCallerIdentity(): { bindingName?: string; instanceNameOrId?: string; type: string } {
    return {
      bindingName: this.lmz.bindingName,
      instanceNameOrId: this.lmz.instanceNameOrId,
      type: this.lmz.type
    };
  }

  // Store last received envelope for inspection
  lastReceivedEnvelope: any = null;

  // Override __executeOperation to capture envelope
  async __executeOperation(envelope: any): Promise<any> {
    this.lastReceivedEnvelope = envelope;
    return await super.__executeOperation(envelope);
  }

  // Test helper to get last envelope
  async getLastEnvelope() {
    return this.lastReceivedEnvelope;
  }

  // Test helpers for this.lmz.call()
  testCallWithContinuations(
    calleeBindingName: string,
    calleeInstanceNameOrId: string | undefined,
    value: string
  ): void {
    const remote = this.ctn<TestDO>().remoteEcho(value);
    this.lmz.call(
      calleeBindingName,
      calleeInstanceNameOrId,
      remote,
      this.ctn().handleCallResult(remote)
    );
  }

  testCallWithError(
    calleeBindingName: string,
    calleeInstanceNameOrId: string | undefined
  ): void {
    const remote = this.ctn<TestDO>().throwError();
    this.lmz.call(
      calleeBindingName,
      calleeInstanceNameOrId,
      remote,
      this.ctn().handleCallError(remote)
    );
  }

  // Handler for successful call results
  @mesh
  handleCallResult(result: any): void {
    this.ctx.storage.kv.put('last_call_result', result);
  }

  // Handler for call errors
  @mesh
  handleCallError(error: any): void {
    this.ctx.storage.kv.put('last_call_error', error instanceof Error ? error.message : String(error));
  }

  // Test helper to get last call result
  async getLastCallResult() {
    return this.ctx.storage.kv.get('last_call_result');
  }

  // Test helper to get last call error
  async getLastCallError() {
    return this.ctx.storage.kv.get('last_call_error');
  }

  // ============================================
  // CallContext capture in handlers test helpers
  // ============================================

  // Test that callContext.state is captured and restored in handlers
  // Sets a unique marker in state before calling, then verifies handler sees it
  @mesh
  testContextCaptureInHandler(
    calleeBindingName: string,
    calleeInstanceName: string,
    stateMarker: string
  ): void {
    // Modify the current callContext.state with a unique marker
    if (this.lmz.callContext) {
      this.lmz.callContext.state['captureTest'] = stateMarker;
    }

    // Fire-and-forget call with a handler that will check the context
    const remote = this.ctn<TestDO>().remoteEcho('capture-test');
    this.lmz.call(
      calleeBindingName,
      calleeInstanceName,
      remote,
      // Pass the expected marker as a parameter so handler can compare
      this.ctn().verifyCapturedContext(stateMarker, remote)
    );
  }

  // Handler that verifies capturedContext.state matches expected marker
  @mesh
  verifyCapturedContext(expectedMarker: string, _remoteResult: any): void {
    const actualMarker = this.lmz.callContext?.state?.['captureTest'];
    const matches = actualMarker === expectedMarker;

    // Store verification result
    this.ctx.storage.kv.put('context_capture_verification', {
      expectedMarker,
      actualMarker,
      matches,
      fullContext: this.lmz.callContext
    });
  }

  // Get context capture verification result
  async getContextCaptureVerification() {
    return this.ctx.storage.kv.get('context_capture_verification');
  }

  // Test interleaved calls with different markers
  @mesh
  testInterleavedContextCapture(
    calleeBindingName: string,
    calleeInstanceName: string,
    markers: string[]
  ): void {
    // Make multiple calls with different markers
    for (const marker of markers) {
      // Each call gets its own marker in state
      if (this.lmz.callContext) {
        this.lmz.callContext.state['captureTest'] = marker;
      }

      const remote = this.ctn<TestDO>().remoteEcho(`interleaved-${marker}`);
      this.lmz.call(
        calleeBindingName,
        calleeInstanceName,
        remote,
        this.ctn().recordInterleavedResult(marker, remote)
      );
    }
  }

  // Handler that records both expected marker and actual context marker
  @mesh
  recordInterleavedResult(expectedMarker: string, _remoteResult: any): void {
    const actualMarker = this.lmz.callContext?.state?.['captureTest'];

    // Append to array of results
    const existing = this.ctx.storage.kv.get('interleaved_results') as any[] || [];
    existing.push({
      expectedMarker,
      actualMarker,
      matches: actualMarker === expectedMarker
    });
    this.ctx.storage.kv.put('interleaved_results', existing);
  }

  // Get interleaved results
  async getInterleavedResults() {
    return this.ctx.storage.kv.get('interleaved_results');
  }

  // Clear interleaved results
  async clearInterleavedResults() {
    this.ctx.storage.kv.delete('interleaved_results');
  }

  // Remote method that throws an error
  @mesh
  throwError(): never {
    throw new Error('Remote error for testing');
  }

  // Validation test helpers (these throw synchronously, which we can test)
  async testLmzCallWithoutBinding(): Promise<void> {
    // This should throw because bindingName is not set
    const remote = this.ctn<TestDO>().remoteEcho('test');
    this.lmz.call('TEST_DO', 'callee', remote, this.ctn().handleCallResult(remote));
  }

  async testLmzCallWithInvalidRemote(): Promise<void> {
    // This should throw because remoteContinuation is invalid
    this.lmz.call(
      'TEST_DO',
      'callee',
      {} as any,
      this.ctn().handleCallResult({})
    );
  }

  async testLmzCallWithInvalidHandler(): Promise<void> {
    // This should throw because handlerContinuation is invalid
    const remote = this.ctn<TestDO>().remoteEcho('test');
    this.lmz.call(
      'TEST_DO',
      'callee',
      remote,
      {} as any
    );
  }

  // ============================================
  // CallContext test helpers
  // ============================================

  // Remote method that returns the current callContext
  @mesh
  getCallContext() {
    return this.lmz.callContext;
  }

  // Remote method that returns the computed caller (callChain.at(-1))
  @mesh
  getCaller() {
    const { callChain } = this.lmz.callContext;
    return callChain.at(-1);
  }

  // Remote method that returns callee identity from this.lmz
  @mesh
  getCalleeIdentity() {
    return {
      bindingName: this.lmz.bindingName,
      instanceName: this.lmz.instanceName
    };
  }

  // Remote method that modifies state and returns the context
  @mesh
  modifyStateAndGetContext(key: string, value: unknown) {
    if (this.lmz.callContext) {
      this.lmz.callContext.state[key] = value;
    }
    return this.lmz.callContext;
  }

  // Remote method that calls another DO and returns combined info
  @mesh
  async callAndReturnContext(
    calleeBindingName: string,
    calleeInstanceName: string
  ) {
    const myContext = this.lmz.callContext;
    const remoteContext = await this.lmz.callRaw(
      calleeBindingName,
      calleeInstanceName,
      this.ctn<TestDO>().getCallContext()
    );
    return {
      myContext,
      remoteContext
    };
  }

  // Test state propagation through call chain
  @mesh
  async testStatePropagation(
    calleeBindingName: string,
    calleeInstanceName: string,
    stateKey: string,
    stateValue: unknown
  ) {
    // Modify state before calling
    if (this.lmz.callContext) {
      this.lmz.callContext.state[stateKey] = stateValue;
    }

    // Call remote and get its context (which should have our state modification)
    const remoteContext = await this.lmz.callRaw(
      calleeBindingName,
      calleeInstanceName,
      this.ctn<TestDO>().getCallContext()
    );

    return {
      stateBeforeCall: this.lmz.callContext?.state,
      remoteState: remoteContext?.state
    };
  }

  // Handler that stores received callContext for inspection
  @mesh
  storeCallContext(): void {
    this.ctx.storage.kv.put('last_call_context', this.lmz.callContext);
  }

  // Get stored callContext
  async getStoredCallContext() {
    return this.ctx.storage.kv.get('last_call_context');
  }

  // Method without @mesh decorator for testing security
  nonMeshMethod(): string {
    return 'should not be callable remotely';
  }

  // ============================================
  // @mesh.guard() test helpers
  // ============================================

  // Method with guard that checks for 'admin' role in callContext.state
  @mesh.guard((instance: TestDO) => {
    const role = instance.lmz.callContext?.state?.['role'];
    if (role !== 'admin') {
      throw new Error('Guard: admin role required');
    }
  })
  guardedAdminMethod(): string {
    return 'admin-only-result';
  }

  // Method with guard that checks for any authenticated user
  @mesh.guard((instance: TestDO) => {
    const userId = instance.lmz.callContext?.state?.['userId'];
    if (!userId) {
      throw new Error('Guard: authentication required');
    }
  })
  guardedAuthMethod(): string {
    return 'authenticated-result';
  }

  // Method with async guard (to test Promise support)
  @mesh.guard(async (instance: TestDO) => {
    // Simulate async check
    await Promise.resolve();
    const token = instance.lmz.callContext?.state?.['token'];
    if (token !== 'valid-token') {
      throw new Error('Guard: valid token required');
    }
  })
  guardedAsyncMethod(): string {
    return 'async-guard-passed';
  }

  // Method that sets state before calling a guarded method
  @mesh
  async callGuardedWithState(
    calleeBindingName: string,
    calleeInstanceName: string,
    stateToSet: Record<string, unknown>
  ): Promise<any> {
    // Set state values before calling
    if (this.lmz.callContext) {
      Object.assign(this.lmz.callContext.state, stateToSet);
    }

    // Call the guarded method
    return await this.lmz.callRaw(
      calleeBindingName,
      calleeInstanceName,
      this.ctn<TestDO>().guardedAdminMethod()
    );
  }

  // Test deep interleaving of async operations within a single call
  // This verifies ALS isolation when a single request makes multiple nested async calls
  @mesh
  async testDeepInterleavingContext(
    targetBindingName: string,
    instancePrefix: string
  ) {
    const results: { position: string; origin: string; expectedOrigin: string }[] = [];
    // Origin is now callChain[0]
    const myOrigin = this.lmz.callContext?.callChain[0]?.instanceName || 'unknown';

    // Record context at start
    results.push({
      position: 'start',
      origin: myOrigin,
      expectedOrigin: myOrigin
    });

    // Make multiple concurrent calls - each should preserve our callContext
    const promises = [
      this.lmz.callRaw(
        targetBindingName,
        `${instancePrefix}-target-1`,
        this.ctn<TestDO>().getCallContext()
      ),
      this.lmz.callRaw(
        targetBindingName,
        `${instancePrefix}-target-2`,
        this.ctn<TestDO>().getCallContext()
      ),
      this.lmz.callRaw(
        targetBindingName,
        `${instancePrefix}-target-3`,
        this.ctn<TestDO>().getCallContext()
      )
    ];

    // Check context mid-execution (after promises started but before awaited)
    const midOrigin = this.lmz.callContext?.callChain[0]?.instanceName || 'unknown';
    results.push({
      position: 'mid-execution',
      origin: midOrigin,
      expectedOrigin: myOrigin
    });

    // Await all and check context after each await point
    const remoteContexts = await Promise.all(promises);

    // Check context after await
    const postAwaitOrigin = this.lmz.callContext?.callChain[0]?.instanceName || 'unknown';
    results.push({
      position: 'post-await',
      origin: postAwaitOrigin,
      expectedOrigin: myOrigin
    });

    // All remote contexts should show us as their origin (callChain[0])
    for (let i = 0; i < remoteContexts.length; i++) {
      results.push({
        position: `remote-${i + 1}-saw-origin`,
        origin: remoteContexts[i]?.callChain[0]?.instanceName || 'unknown',
        expectedOrigin: myOrigin
      });
    }

    // Final context check
    const finalOrigin = this.lmz.callContext?.callChain[0]?.instanceName || 'unknown';
    results.push({
      position: 'final',
      origin: finalOrigin,
      expectedOrigin: myOrigin
    });

    return {
      allContextsMatch: results.every(r => r.origin === r.expectedOrigin),
      results
    };
  }

  // ============================================
  // Two-one-way calls context preservation tests
  // Tests that when Target calls back to Origin, the callContext reflects
  // the new call chain (Target as origin) rather than the original.
  // ============================================

  /** Storage for callback context received */
  #twoOneWayCallbackContext: any = null;

  /**
   * Initiates a two-one-way call pattern:
   * 1. Origin (this) calls Target
   * 2. Target receives, then calls back to Origin's receiveCallback method
   * 3. Origin stores the callback's callContext for verification
   */
  @mesh
  async initiateTwoOneWayCall(
    targetBindingName: string,
    targetInstanceName: string,
    marker: string
  ): Promise<void> {
    // Call target, asking it to call us back
    // We pass our identity so Target knows where to call back
    await this.lmz.callRaw(
      targetBindingName,
      targetInstanceName,
      this.ctn<TestDO>().handleAndCallback(
        this.lmz.bindingName!,
        this.lmz.instanceNameOrId!,
        marker
      )
    );
  }

  /**
   * Target receives this call, then independently calls back to Origin
   */
  @mesh
  async handleAndCallback(
    callerBindingName: string,
    callerInstanceName: string,
    marker: string
  ): Promise<string> {
    // Store my callContext when I received this call
    const { callChain } = this.lmz.callContext;
    const myIncomingContext = {
      callChain,
      caller: callChain.at(-1),
    };

    // Now call back to the original caller
    // This is an INDEPENDENT call, not a return value
    // The callback's callContext should preserve the original origin
    await this.lmz.callRaw(
      callerBindingName,
      callerInstanceName,
      this.ctn<TestDO>().receiveCallback(marker, myIncomingContext)
    );

    return 'callback-sent';
  }

  /**
   * Origin receives the callback from Target
   * Stores the callContext for later verification
   */
  @mesh
  receiveCallback(marker: string, targetIncomingContext: any): void {
    // Store the callback's callContext for verification
    // callChain[0] is origin, callChain.at(-1) is caller
    const { callChain } = this.lmz.callContext;
    this.#twoOneWayCallbackContext = {
      marker,
      targetIncomingContext,
      callbackContext: {
        callChain,
        caller: callChain.at(-1),
      }
    };
    this.ctx.storage.kv.put('two_one_way_result', this.#twoOneWayCallbackContext);
  }

  /** Get the stored two-one-way callback result */
  getTwoOneWayResult(): any {
    return this.ctx.storage.kv.get('two_one_way_result') ?? this.#twoOneWayCallbackContext;
  }

  /** Clear the two-one-way result for fresh tests */
  clearTwoOneWayResult(): void {
    this.#twoOneWayCallbackContext = null;
    this.ctx.storage.kv.delete('two_one_way_result');
  }
}

// Test DO that uses onStart() lifecycle hook
export class OnStartTestDO extends LumenizeDO<Env> {
  // Track whether onStart was called
  #onStartCalled = false;

  async onStart() {
    // Store a flag in storage to prove onStart ran
    this.ctx.storage.kv.put('__test_onstart_called', true);

    // Create a table (common use case for onStart)
    this.svc.sql`
      CREATE TABLE IF NOT EXISTS onstart_test (
        id TEXT PRIMARY KEY,
        value TEXT
      )
    `;

    this.#onStartCalled = true;
  }

  // Test helper: Check if onStart was called
  wasOnStartCalled(): boolean {
    return this.#onStartCalled;
  }

  // Test helper: Check storage flag
  getOnStartFlag(): boolean | undefined {
    return this.ctx.storage.kv.get('__test_onstart_called') as boolean | undefined;
  }

  // Test helper: Insert into the table created by onStart
  insertValue(id: string, value: string): void {
    this.svc.sql`INSERT INTO onstart_test (id, value) VALUES (${id}, ${value})`;
  }

  // Test helper: Get value from the table
  getValue(id: string): { id: string; value: string } | undefined {
    const rows = this.svc.sql`SELECT * FROM onstart_test WHERE id = ${id}`;
    return rows[0] as { id: string; value: string } | undefined;
  }
}

// Test DO that throws in onStart()
export class OnStartErrorDO extends LumenizeDO<Env> {
  async onStart() {
    throw new Error('Intentional onStart error for testing');
  }

  // This should never be reachable if onStart fails
  getValue(): string {
    return 'should-not-reach';
  }
}

// Test Worker class for Worker-to-DO and Worker-to-Worker tests
export class TestWorker extends LumenizeWorker<Env> {
  // Store last received envelope for inspection
  lastReceivedEnvelope: any = null;

  // Override __executeOperation to capture envelope
  async __executeOperation(envelope: any): Promise<any> {
    this.lastReceivedEnvelope = envelope;
    return await super.__executeOperation(envelope);
  }

  // Test helper to get last envelope
  async getLastEnvelope() {
    return this.lastReceivedEnvelope;
  }

  // Identity getter methods for tests
  getType(): string {
    return this.lmz.type;
  }

  getBindingName(): string | undefined {
    return this.lmz.bindingName;
  }

  setBindingName(name: string | undefined): void {
    if (name === undefined) {
      // Reset by creating a new lmzApi (hack for tests)
      (this as any).lmzApi = null;
    } else {
      this.lmz.bindingName = name;
    }
  }

  initWithBindingName(name: string): void {
    this.lmz.init({ bindingName: name });
  }

  getInstanceName(): string | undefined {
    return this.lmz.instanceName;
  }

  getId(): string | undefined {
    return this.lmz.id;
  }

  getInstanceNameOrId(): string | undefined {
    return this.lmz.instanceNameOrId;
  }

  // Test setter/getter in same call (Workers are stateless between calls)
  testBindingNameSetterGetter(name: string): string {
    this.lmz.bindingName = name;
    return this.lmz.bindingName!;
  }

  testInitBindingName(name: string): string {
    this.lmz.init({ bindingName: name });
    return this.lmz.bindingName!;
  }

  // Continuation test methods
  testContinuationCreation(): string {
    const ctn = this.ctn<TestWorker>();
    // If we can create it without error, return success
    return 'continuation_works';
  }

  testContinuationToChain(): any {
    const ctn = this.ctn<TestWorker>().workerEcho('test');
    const chain = getOperationChain(ctn);
    return chain;
  }

  // Envelope test methods
  async testValidEnvelope(): Promise<string> {
    const chain = { 
      operations: [
        { type: 'call', property: 'workerEcho', args: ['envelope_test'] }
      ] 
    };
    const preprocessedChain = preprocess(chain);
    const envelope = {
      version: 1,
      chain: preprocessedChain,
      metadata: {}
    };
    
    await this.__executeOperation(envelope);
    return 'envelope_test_success';
  }

  async testAutoInitFromEnvelope(): Promise<string> {
    const chain = { 
      operations: [
        { type: 'call', property: 'getBindingName', args: [] }
      ] 
    };
    const preprocessedChain = preprocess(chain);
    const envelope = {
      version: 1,
      chain: preprocessedChain,
      metadata: {
        callee: {
          type: 'LumenizeWorker',
          bindingName: 'AUTO_INIT_WORKER',
          instanceNameOrId: undefined
        }
      }
    };
    
    return await this.__executeOperation(envelope);
  }

  // Identity test (must be in single call)
  testGetIdentityAfterInit(name: string): { type: string; bindingName: string } {
    this.lmz.init({ bindingName: name });
    return {
      type: this.lmz.type,
      bindingName: this.lmz.bindingName!
    };
  }

  // Test helpers for Worker RPC calls
  async testCallRawToDO(
    doBindingName: string,
    doInstanceNameOrId: string,
    value: string
  ): Promise<any> {
    return await this.lmz.callRaw(
      doBindingName,
      doInstanceNameOrId,
      this.ctn<TestDO>().remoteEcho(value)
    );
  }

  async testCallRawToWorker(
    workerBindingName: string,
    value: string
  ): Promise<any> {
    return await this.lmz.callRaw(
      workerBindingName,
      undefined,
      this.ctn<TestWorker>().workerEcho(value)
    );
  }

  // Remote methods that can be called via RPC
  @mesh
  workerEcho(value: string): string {
    return `worker-echo: ${value}`;
  }

  @mesh
  getWorkerIdentity(): { bindingName?: string; type: string } {
    return {
      bindingName: this.lmz.bindingName,
      type: this.lmz.type
    };
  }

  // Test that Workers silently ignore instance-related setters
  testInstanceSetters(): boolean {
    this.lmz.instanceName = 'should-be-ignored';
    this.lmz.id = 'should-be-ignored';
    this.lmz.instanceNameOrId = 'should-be-ignored';

    // All should remain undefined
    return (
      this.lmz.instanceName === undefined &&
      this.lmz.id === undefined &&
      this.lmz.instanceNameOrId === undefined
    );
  }

  // ============================================
  // CallContext test helpers for Worker
  // ============================================

  @mesh
  getCallContext() {
    return this.lmz.callContext;
  }

  @mesh
  getCaller() {
    const { callChain } = this.lmz.callContext;
    return callChain.at(-1);
  }

  // Worker that forwards call to a DO and returns both contexts
  @mesh
  async forwardToDO(
    doBindingName: string,
    doInstanceName: string
  ) {
    const myContext = this.lmz.callContext;
    const doContext = await this.lmz.callRaw(
      doBindingName,
      doInstanceName,
      this.ctn<TestDO>().getCallContext()
    );
    return {
      workerContext: myContext,
      doContext
    };
  }
}

// Simple EchoDO for testing LumenizeClientGateway
// Echoes back the input with context info
export class EchoDO extends LumenizeDO<Env> {
  @mesh
  echo(message: string): { message: string; callChain?: any; caller?: any } {
    const { callChain } = this.lmz.callContext;
    return {
      message: `Echo: ${message}`,
      callChain,
      caller: callChain.at(-1),
    };
  }

  @mesh
  getCallContext() {
    return this.lmz.callContext;
  }
}

// Import routeDORequest for e2e testing with Browser.WebSocket
import { routeDORequest } from '@lumenize/utils';
import { createWebSocketAuthMiddleware, createAuthMiddleware } from '@lumenize/auth';

// Default export for worker - routes to DOs for e2e testing
export default {
  async fetch(request: Request, env: Env) {
    // For e2e tests, we need to route WebSocket connections to the Gateway
    // The routeDORequest function matches URLs like /gateway/LUMENIZE_CLIENT_GATEWAY/{instanceName}
    // and routes them to the appropriate DO

    // Get public keys from env (from .dev.vars)
    const publicKeys = [env.JWT_PUBLIC_KEY_BLUE, env.JWT_PUBLIC_KEY_GREEN].filter(Boolean);

    // Create auth middleware for WebSocket and HTTP requests
    const wsAuth = await createWebSocketAuthMiddleware({ publicKeysPem: publicKeys });
    const httpAuth = await createAuthMiddleware({ publicKeysPem: publicKeys });

    const response = await routeDORequest(request, env, {
      prefix: 'gateway',
      onBeforeConnect: wsAuth,
      onBeforeRequest: httpAuth,
    });

    if (response) {
      return response;
    }

    return new Response('OK');
  },
};

