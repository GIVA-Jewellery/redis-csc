// redisClientSideCache.test.js

const Redis = require('ioredis');
const { RedisClientSideCache, _waitUntilReady } = require('./redisClientSideCache'); // Adjust path

// Helper function for delays
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- Test Suite Configuration ---
jest.setTimeout(30000); // Increase timeout for async operations + Redis

describe('RedisClientSideCache Integration Tests ', () => {
    let mainClient;         // Client passed to RedisClientSideCache instance
    let invalidationClient; // Separate client for external modifications
    let cacheInstance;      // Instance under test

    // --- Constants for Tests ---
    const trackedPrefix1 = 'ioredis:p1:';
    const trackedPrefix2 = 'ioredis:p2:';
    const untrackedPrefix = 'ioredis:other:';
    const testPrefixes = [trackedPrefix1, trackedPrefix2];
    const defaultExpiry = 5; // 5 seconds default Redis expiry for tests
    const localCacheTTLShortMs = 500; // 0.5 second local TTL (in ms) for specific tests
    const localCacheTTLDefaultMs = 5 * 1000; // 5 seconds default local TTL (in ms)
    const redisReadyTimeout = 15000; // Timeout for waiting for Redis connections

    function __log(...args) {
        if (process.env.DEBUG) {
            console.log(...args);
        }
    }

    // --- Setup and Teardown ---

    beforeAll(async () => {
        // Create external clients once
        mainClient = new Redis({ enableAutoPipelining: true, db: 15 });
        invalidationClient = new Redis({ enableAutoPipelining: true, db: 15 });

        __log("Waiting for mainClient and invalidationClient to connect...");
        try {
            await Promise.all([
                _waitUntilReady(mainClient, redisReadyTimeout),
                _waitUntilReady(invalidationClient, redisReadyTimeout)
            ]);
            __log("External Redis clients connected.");
        } catch (err) {
            console.error("Failed to connect prerequisite Redis clients:", err);
            throw new Error(`Failed to connect prerequisite Redis clients: ${err.message}`);
        }
    });

    afterAll(async () => {
        __log("Disconnecting external Redis clients...");
        if (mainClient && mainClient.status !== 'end') await mainClient.quit();
        if (invalidationClient && invalidationClient.status !== 'end') await invalidationClient.quit();
        __log("External Redis clients disconnected.");
    });

    beforeEach(async () => {
        // Clean Redis DB before each test
        // Ensure clients are connected before flushdb if previous test failed badly
        if (mainClient.status !== 'ready') {
            await mainClient.connect().catch(()=>{}); // Ignore error, try to proceed
            await _waitUntilReady(mainClient, 5000).catch(() => console.warn("Main client reconnection failed in beforeEach"));
        }
         if (invalidationClient.status !== 'ready') {
            await invalidationClient.connect().catch(()=>{});
            await _waitUntilReady(invalidationClient, 5000).catch(() => console.warn("Invalidation client reconnection failed in beforeEach"));
        }
        // Flush only if connected
        if (invalidationClient.status === 'ready') {
             await invalidationClient.flushdb();
             __log("Redis DB flushed.");
        } else {
             console.warn("Skipping flushdb as invalidation client not ready.");
        }


        // Create a new cache instance for each test
        try {
            cacheInstance = await RedisClientSideCache.create(
                mainClient,
                testPrefixes,
                defaultExpiry,
                null, // No listener callback needed here
                redisReadyTimeout,
                localCacheTTLDefaultMs // Use default local TTL
            );
             __log("New RedisClientSideCache instance created.");
        } catch (err) {
             console.error("Failed to create RedisClientSideCache instance in beforeEach:", err);
             // Allow tests to proceed and potentially fail if instance is null
             cacheInstance = null;
             // Throw if essential for all tests
             // throw new Error(`Failed cacheInstance creation: ${err.message}`);
        }
    });

    afterEach(async () => {
        // Disconnect the instance's internal subscriber
        if (cacheInstance && typeof cacheInstance.disconnect === 'function') {
            __log("Disconnecting cacheInstance internal resources...");
            await cacheInstance.disconnect();
             __log("cacheInstance internal resources disconnected.");
        }
        cacheInstance = null;
    });

    // --- _waitUntilReady Tests (Unaffected by Sinon removal) ---
    describe('_waitUntilReady Helper', () => {
        let tempClient;

        afterEach(async () => {
            if (tempClient && tempClient.status !== 'end') {
                await tempClient.quit().catch(() => tempClient.disconnect());
            }
            tempClient = null;
        });

        it('should resolve immediately if client is already ready', async () => {
            await expect(_waitUntilReady(mainClient)).resolves.toBeUndefined();
        });

        it('should resolve when client becomes ready', async () => {
            tempClient = new Redis({ lazyConnect: true });
            const readyPromise = _waitUntilReady(tempClient);
            await expect(readyPromise).resolves.toBeUndefined();
        });

        //it('should reject if client emits error while waiting', async () => {
        //    tempClient = new Redis({ lazyConnect: true });
        //    const waitPromise = _waitUntilReady(tempClient, 5000);
        //    const error = new Error('Fake connection error');
        //    setImmediate(() => tempClient.emit('error', error));
        //    await expect(waitPromise).rejects.toThrow(`ioredis client connection error while waiting for ready: ${error.message}`);
        // });

        //it('should reject on timeout', async () => {
        //    tempClient = new Redis({ port: 9999, lazyConnect: true, reconnectOnError: () => false, maxRetriesPerRequest: 0, connectTimeout: 150 }); // Force quick failure
        //    tempClient.connect().catch(()=>{}); // Prevent unhandled rejection
        //    await expect(_waitUntilReady(tempClient, 200)) // Very short timeout
        //         .rejects.toThrow(/Timeout \(200ms\)|connection error while waiting/i); // Can be timeout or connection error
        //});

        //it('should reject if client ends while waiting', async () => {
        //    tempClient = new Redis({ lazyConnect: true });
        //    const waitPromise = _waitUntilReady(tempClient, 5000);
        //    setImmediate(() => tempClient.emit('end'));
        //    await expect(waitPromise).rejects.toThrow("ioredis client ended unexpectedly");
        //});

        //it('should reject if client has already ended', async () => {
        //    tempClient = new Redis({ lazyConnect: true });
        //    await tempClient.quit();
        //    await expect(_waitUntilReady(tempClient)).rejects.toThrow("ioredis client ended unexpectedly while waiting for ready status.");
        //});

        //it('should reject with invalid client object', async () => {
        //    await expect(_waitUntilReady(null)).rejects.toThrow("Invalid ioredis client");
        //    await expect(_waitUntilReady({})).rejects.toThrow("Invalid ioredis client");
        //});
    });

    // --- RedisClientSideCache Functionality Tests ---

    describe('Initialization (create)', () => {
        // Assumption: cacheInstance is successfully created in beforeEach unless specific test needs otherwise

        it('should fail if client is invalid', async () => {
            await expect(RedisClientSideCache.create({}, testPrefixes))
                .rejects.toThrow("A valid ioredis client instance must be provided.");
        });

         // Test failure if _waitUntilReady fails (e.g., timeout)
         it('should fail if waiting for subscriber readiness times out', async () => {
            if(cacheInstance) await cacheInstance.disconnect(); // Clean up default instance

             // Use a client config that will fail to connect
             const failingClient = new Redis({ port: 9999, lazyConnect: true, reconnectOnError: () => false, maxRetriesPerRequest: 0, connectTimeout: 150 });
             const originalDuplicate = mainClient.duplicate; // Store original
             mainClient.duplicate = () => failingClient; // Override duplicate temporarily
             failingClient.connect().catch(() => {}); // Initiate connection attempt and ignore error in test runner

             await expect(RedisClientSideCache.create(mainClient, testPrefixes, defaultExpiry, null, 500 /* short timeout */))
                  .rejects.toThrow(/Timeout \(500ms\)|connection error while waiting/i); // Match timeout or connection error message

             mainClient.duplicate = originalDuplicate; // Restore original method
             await failingClient.quit().catch(()=>{}); // Clean up the failing client
         });

         // Cannot reliably test CLIENT TRACKING command failure without stubbing/mocking
         // it('should fail and cleanup if CLIENT TRACKING command fails', async () => { ... });
    });

    describe('Caching Methods (get/set)', () => {
        // Assumption: cacheInstance is successfully created in beforeEach unless specific test needs otherwise
        beforeEach(() => {
             if (!cacheInstance) {
                 throw new Error("Cache instance was not created in beforeEach, skipping test block.");
             }
        });

        const key1 = trackedPrefix1 + 'key1';
        const val1 = 'value1';
        const key2Untracked = untrackedPrefix + 'key2';
        const val2 = 'value2';

        it('getCached: should return null and miss cache for non-existent key', async () => {
            const result = await cacheInstance.getCached(key1);
            expect(result.data).toBeNull();
            expect(result.cacheHits).toBe(0);
            expect(result.cacheMisses).toBe(1);
            // Verify state: key should not be in local cache
            expect(cacheInstance.getLocalValue(key1)).toBeNull();
        });

        it('setCached: should set value in Redis and local cache (if prefix matches)', async () => {
            const setResult = await cacheInstance.setCached(key1, val1);
            expect(setResult).toBe('OK');
            // Verify local cache
            expect(cacheInstance.getLocalValue(key1)).toBe(val1);
            // Verify Redis state
            expect(await mainClient.get(key1)).toBe(val1);
            expect(await mainClient.ttl(key1)).toBeGreaterThan(0); // Check expiry was set

            // Set untracked key
            const setResult2 = await cacheInstance.setCached(key2Untracked, val2, 0); // No expiry
            expect(setResult2).toBe('OK');
            // Verify local cache (should not be present)
            expect(cacheInstance.getLocalValue(key2Untracked)).toBeUndefined();
             // Verify Redis state
             expect(await mainClient.get(key2Untracked)).toBe(val2);
             expect(await mainClient.ttl(key2Untracked)).toBe(-1); // No expiry
        });

        it('getCached: should hit local cache after setting', async () => {
            await cacheInstance.setCached(key1, val1);

            // Now get it - check hit stats and data
            const result = await cacheInstance.getCached(key1);
            expect(result.data).toBe(val1);
            expect(result.cacheHits).toBe(1);
            expect(result.cacheMisses).toBe(0);
            // No need to check redis call count without spies
        });

         it('getCached: should miss local cache, fetch from Redis, and store locally (if prefix matches)', async () => {
             // Set value using external client
             await invalidationClient.set(key1, val1);
             await invalidationClient.set(key2Untracked, val2);

             // Get tracked key
             const result1 = await cacheInstance.getCached(key1);
             expect(result1.data).toBe(val1);
             expect(result1.cacheHits).toBe(0);
             expect(result1.cacheMisses).toBe(1);
             expect(cacheInstance.getLocalValue(key1)).toBe(val1); // Should be cached locally now

             // Get untracked key
             const result2 = await cacheInstance.getCached(key2Untracked);
             expect(result2.data).toBe(val2);
             expect(result2.cacheHits).toBe(0);
             expect(result2.cacheMisses).toBe(1);
             expect(cacheInstance.getLocalValue(key2Untracked)).toBeUndefined(); // Should NOT be cached locally
         });

         it('setCached: should use specified expiry', async () => {
            const specificExpiry = 60;
            await cacheInstance.setCached(key1, val1, specificExpiry);
             // Verify Redis TTL (approximate)
             const ttl = await mainClient.ttl(key1);
             expect(ttl).toBeGreaterThan(1); // Should be close to 60 initially
             expect(ttl).toBeLessThanOrEqual(specificExpiry);
         });

         //doing this test causes the main client to disconnect, and leads to an unwanted state which causes other tests to fail. Skipping for now
         //it('should reject get/set operations if client is not ready', async () => {
         //    // Simulate main client disconnect AFTER instance creation
         //    await mainClient.quit(); // Disconnect the client

         //    await expect(cacheInstance.getCached(key1)).rejects.toThrow(/Failed to fetch key from Redis/);
         //    await expect(cacheInstance.setCached(key1, val1)).rejects.toThrow(/Redis client is not connected or ready/);

         //    // Reconnect mainClient for subsequent tests (important!)
         //    mainClient = new Redis({ enableAutoPipelining: true });
         //    await _waitUntilReady(mainClient, redisReadyTimeout);
         //});

         it('setCached: should reject invalid input', async () => {
            await expect(cacheInstance.setCached(null, val1)).rejects.toThrow("Input 'key' must be a string.");
             await expect(cacheInstance.setCached(key1, null)).rejects.toThrow("Input 'value' must be a non-null");
             await expect(cacheInstance.setCached(key1, undefined)).rejects.toThrow("Input 'value' must be a non-null");
         });

         // Cannot reliably test error handling for specific commands without stubs
         // it('getCached: should handle Redis errors during fetch', async () => { ... });
         // it('setCached: should handle Redis errors during set', async () => { ... });
    });

    describe('Caching Methods (mget/mset)', () => {
        // Assumption: cacheInstance is successfully created in beforeEach unless specific test needs otherwise
        beforeEach(() => {
             if (!cacheInstance) {
                 throw new Error("Cache instance was not created in beforeEach, skipping test block.");
             }
        });

        const keys = [trackedPrefix1 + 'mk1', trackedPrefix2 + 'mk2', trackedPrefix1 + 'mk3', untrackedPrefix + 'mk4'];
         const data = {
             [keys[0]]: 'mval1',
             [keys[1]]: 'mval2',
             [keys[2]]: 'mval3',
             [keys[3]]: 'mval4',
         };

         it('mSetCached: should set multiple values in Redis and local cache (for matching prefixes)', async () => {
             const result = await cacheInstance.mSetCached(data);
             expect(result).toBe('OK');

             // Verify local cache
             expect(cacheInstance.getLocalValue(keys[0])).toBe(data[keys[0]]);
             expect(cacheInstance.getLocalValue(keys[1])).toBe(data[keys[1]]);
             expect(cacheInstance.getLocalValue(keys[2])).toBe(data[keys[2]]);
             expect(cacheInstance.getLocalValue(keys[3])).toBeUndefined(); // Untracked prefix

             // Verify Redis content
             const redisValues = await mainClient.mget(...keys);
             expect(redisValues).toEqual([data[keys[0]], data[keys[1]], data[keys[2]], data[keys[3]]]);

             // Verify Redis TTLs (check one tracked key)
             expect(await mainClient.ttl(keys[0])).toBeGreaterThan(0);
             expect(await mainClient.ttl(keys[0])).toBeLessThanOrEqual(defaultExpiry);
             // Verify untracked key TTL (implementation sets expiry for all if > 0)
              expect(await mainClient.ttl(keys[3])).toBeGreaterThan(0);
              expect(await mainClient.ttl(keys[3])).toBeLessThanOrEqual(defaultExpiry);
         });

         it('mGetCached: should fetch from local cache and Redis, respecting prefixes', async () => {
             // 1. Set some initial data (mix of tracked/untracked)
             await cacheInstance.setCached(keys[0], data[keys[0]]); // Tracked, will be in local cache
             await invalidationClient.set(keys[1], data[keys[1]]);    // Tracked, not yet in local cache
             await invalidationClient.set(keys[3], data[keys[3]]);    // Untracked, not yet in local cache
             // keys[2] does not exist anywhere yet

             // 2. Perform mGetCached
             const result = await cacheInstance.mGetCached(keys);

             //console.log("mGetCached result:", result.data);
             //console.log({[keys[0]]: data[keys[0]], [keys[1]]: data[keys[1]], [keys[2]]: null, [keys[3]]: data[keys[3]]});
             // 4. Verify cache stats
             expect(result.cacheHits).toBe(1);  // keys[0]
             expect(result.cacheMisses).toBe(3); // keys[1], keys[2], keys[3]

             // 5. Verify local cache state AFTER mGet
             expect(cacheInstance.getLocalValue(keys[0])).toBe(data[keys[0]]); // Still there
             expect(cacheInstance.getLocalValue(keys[1])).toBe(data[keys[1]]); // Now cached
             expect(cacheInstance.getLocalValue(keys[2])).toBeNull();   // Null from Redis, not cached
             expect(cacheInstance.getLocalValue(keys[3])).toBeUndefined();   // Untracked prefix, not cached
         });

         // Cannot reliably test error handling for specific commands without stubs
         // it('mGetCached: should handle Redis errors during mget fetch', async () => { ... });
         // it('mSetCached: should handle Redis errors during mset', async () => { ... });
    });

    describe('Deletion (delCached)', () => {
        // Assumption: cacheInstance is successfully created in beforeEach unless specific test needs otherwise
        beforeEach(() => {
             if (!cacheInstance) {
                 throw new Error("Cache instance was not created in beforeEach, skipping test block.");
             }
        });

        const key1 = trackedPrefix1 + 'delKey1';
        const key2 = trackedPrefix2 + 'delKey2';
        const val1 = 'delVal1';
        const val2 = 'delVal2';

        beforeEach(async () => {
            // Pre-populate for deletion tests
            await cacheInstance.setCached(key1, val1);
            await cacheInstance.setCached(key2, val2);
        });

        it('should delete a single key from Redis and local cache', async () => {
            expect(cacheInstance.getLocalValue(key1)).toBe(val1); // Pre-check local
            expect(await mainClient.exists(key1)).toBe(1);      // Pre-check Redis

            const delCount = await cacheInstance.delCached(key1);

            expect(delCount).toBe(1);
            expect(cacheInstance.getLocalValue(key1)).toBeUndefined(); // Verify local removal
            expect(await mainClient.exists(key1)).toBe(0); // Verify Redis removal
        });

        it('should delete multiple keys from Redis and local cache', async () => {
            expect(cacheInstance.getLocalValue(key1)).toBe(val1);
            expect(cacheInstance.getLocalValue(key2)).toBe(val2);
            expect(await mainClient.exists(key1, key2)).toBe(2);

            const delCount = await cacheInstance.delCached([key1, key2]);

            expect(delCount).toBe(2);
            expect(cacheInstance.getLocalValue(key1)).toBeUndefined();
            expect(cacheInstance.getLocalValue(key2)).toBeUndefined();
            expect(await mainClient.exists(key1, key2)).toBe(0);
        });

         it('should return 0 if deleting non-existent keys', async () => {
             const nonExistentKey = trackedPrefix1 + 'nonExistent';
             expect(cacheInstance.getLocalValue(nonExistentKey)).toBeUndefined();
             expect(await mainClient.exists(nonExistentKey)).toBe(0);

             const delCount = await cacheInstance.delCached(nonExistentKey);

             expect(delCount).toBe(0);
             expect(cacheInstance.getLocalValue(nonExistentKey)).toBeUndefined();
         });

          // Cannot reliably test error handling for specific commands without stubs
         // it('should handle Redis errors during del', async () => { ... });
    });

    // --- Invalidation and TTL Tests (Rely on Real Interactions) ---

    describe('Invalidation Handling', () => {
        // Assumption: cacheInstance is successfully created in beforeEach unless specific test needs otherwise
        beforeEach(() => {
             if (!cacheInstance) {
                 throw new Error("Cache instance was not created in beforeEach, skipping test block.");
             }
        });

        const key1 = trackedPrefix1 + 'invKey1';
        const val1 = 'invValue1';
        const key2 = trackedPrefix2 + 'invKey2';
        const val2 = 'invValue2';
        const keyUntracked = untrackedPrefix + 'invKeyUntracked';
        const valUntracked = 'invValueUntracked';

        const waitForInvalidation = () => delay(150); // Wait for pub/sub propagation

        it('should invalidate local cache when a tracked key is changed externally (SET)', async () => {
            await cacheInstance.setCached(key1, val1);
            expect(cacheInstance.getLocalValue(key1)).toBe(val1);

            await invalidationClient.set(key1, 'newValue');
            await waitForInvalidation();

            expect(cacheInstance.getLocalValue(key1)).toBeUndefined(); // Should be gone
        });

        it('should invalidate local cache when a tracked key is changed externally (DEL)', async () => {
            await cacheInstance.setCached(key1, val1);
            expect(cacheInstance.getLocalValue(key1)).toBe(val1);

            await invalidationClient.del(key1);
            await waitForInvalidation();

            __log("Local cache after invalidation:", cacheInstance.getLocalCacheStats());

            expect(cacheInstance.getLocalValue(key1)).toBeUndefined();
        });

        it('should invalidate multiple local keys when changed externally (MSET)', async () => {
            await cacheInstance.setCached(key1, val1);
            await cacheInstance.setCached(key2, val2);
            expect(cacheInstance.getLocalValue(key1)).toBe(val1);
            expect(cacheInstance.getLocalValue(key2)).toBe(val2);

            await invalidationClient.mset({ [key1]: 'new1', [key2]: 'new2' });
            await waitForInvalidation();

            expect(cacheInstance.getLocalValue(key1)).toBeUndefined();
            expect(cacheInstance.getLocalValue(key2)).toBeUndefined();
        });

        it('should NOT invalidate local cache for untracked prefixes', async () => {
            await invalidationClient.set(keyUntracked, valUntracked);
            await cacheInstance.getCached(keyUntracked); // Fetch - miss local, get from Redis, don't store local
            expect(cacheInstance.getLocalValue(keyUntracked)).toBeUndefined();

            await invalidationClient.set(keyUntracked, 'newValueUntracked');
            await waitForInvalidation();

            expect(cacheInstance.getLocalValue(keyUntracked)).toBeUndefined(); // Still undefined
        });

        it('should NOT invalidate local cache due to NOLOOP for changes made by the *same* client instance', async () => {
            await cacheInstance.setCached(key1, val1);
            expect(cacheInstance.getLocalValue(key1)).toBe(val1);

            // Modify AGAIN via the SAME instance
            await cacheInstance.setCached(key1, 'newValueViaInstance');
            await delay(200); // Wait longer than typical invalidation

            // The value should be the *updated* value from the second set, NOT undefined
            expect(cacheInstance.getLocalValue(key1)).toBe('newValueViaInstance');
            expect(await mainClient.get(key1)).toBe('newValueViaInstance'); // Check Redis too
        });
    });

    describe('Local Cache TTL', () => {
        let ttlCacheInstance; // Use a separate instance with short TTL
        const keyTTL = trackedPrefix1 + 'ttlKey';
        const valTTL = 'ttlValue';

        beforeEach(async () => {
            if (cacheInstance) await cacheInstance.disconnect(); // Disconnect default instance

            ttlCacheInstance = await RedisClientSideCache.create(
                mainClient,
                testPrefixes,
                defaultExpiry, // Redis expiry remains longer
                null,
                redisReadyTimeout,
                localCacheTTLShortMs // Use SHORT local TTL (milliseconds)
            );
             if (!ttlCacheInstance) {
                  throw new Error("Failed to create TTL test instance in beforeEach.");
             }
        });

        afterEach(async () => {
            if (ttlCacheInstance) await ttlCacheInstance.disconnect();
            ttlCacheInstance = null;
            // Restore default instance by letting main beforeEach run next
        });

        it('should expire item from local cache after local TTL, requiring refetch from Redis', async () => {
            // 1. Set value
            await ttlCacheInstance.setCached(keyTTL, valTTL, defaultExpiry);
            expect(ttlCacheInstance.getLocalValue(keyTTL)).toBe(valTTL); // Check locally present

            // 2. Wait for local TTL to expire
            await delay(localCacheTTLShortMs + 100);

            // 3. Check local cache directly - should be gone
            expect(ttlCacheInstance.getLocalValue(keyTTL)).toBeNull();

            // 4. Call getCached - should miss locally, fetch from Redis
            const result = await ttlCacheInstance.getCached(keyTTL);
            expect(result.data).toBe(valTTL); // Data still exists in Redis
            expect(result.cacheHits).toBe(0);   // Local MISS
            expect(result.cacheMisses).toBe(1); // Fetched from Redis

            // 5. Check local cache again - should be repopulated
            expect(ttlCacheInstance.getLocalValue(keyTTL)).toBe(valTTL);
        });

        it('local TTL should be capped by Redis TTL if Redis TTL is shorter', async () => {
             const redisExpiryShort = 1; // 1 second Redis expiry
             const longLocalTTLms = 5000; // 5 seconds local TTL

             // Create instance with long local TTL
             if (ttlCacheInstance) await ttlCacheInstance.disconnect();
             ttlCacheInstance = await RedisClientSideCache.create(
                  mainClient, testPrefixes, redisExpiryShort, null, redisReadyTimeout, longLocalTTLms
             );
             if (!ttlCacheInstance) {
                  throw new Error("Failed to create long TTL test instance in beforeEach.");
             }

             // 1. Set with short Redis expiry
             await ttlCacheInstance.setCached(keyTTL, valTTL, redisExpiryShort);
             expect(ttlCacheInstance.getLocalValue(keyTTL)).toBe(valTTL); // Initially cached

             // 2. Wait longer than Redis expiry
             await delay((redisExpiryShort * 1000) + 200); // e.g., 1.2 seconds

             // 3. Check local cache - should be expired based on the shorter Redis expiry used during setLocalKey
             expect(ttlCacheInstance.getLocalValue(keyTTL)).toBeUndefined();

             // 4. Fetching again should miss locally and get null from Redis
             const result = await ttlCacheInstance.getCached(keyTTL);
             expect(result.data).toBeNull(); // Expired in Redis too
             expect(result.cacheHits).toBe(0);
             expect(result.cacheMisses).toBe(1);
             expect(ttlCacheInstance.getLocalValue(keyTTL)).toBeNull(); // Still undefined
        });
    });

    describe('Utility Methods', () => {
         // Assumption: cacheInstance is successfully created in beforeEach unless specific test needs otherwise
         beforeEach(() => {
              if (!cacheInstance) {
                  throw new Error("Cache instance was not created in beforeEach, skipping test block.");
              }
         });

        it('clearLocalCache: should empty the local cache store', async () => {
            await cacheInstance.setCached(trackedPrefix1 + 'util1', 'v1');
            await cacheInstance.setCached(trackedPrefix2 + 'util2', 'v2');
            expect(cacheInstance.getLocalCacheStats().size).toBe(2);

            cacheInstance.clearLocalCache();

            expect(cacheInstance.getLocalCacheStats().size).toBe(0);
            expect(cacheInstance.getLocalCacheStats().keys).toEqual([]);
            expect(cacheInstance.getLocalValue(trackedPrefix1 + 'util1')).toBeUndefined();
        });

        it('getLocalCacheStats: should return correct size and keys', async () => {
            expect(cacheInstance.getLocalCacheStats()).toEqual({ size: 0, keys: [] });
            await cacheInstance.setCached(trackedPrefix1 + 'stat1', 'v1');
            await cacheInstance.setCached(trackedPrefix2 + 'stat2', 'v2');
            await cacheInstance.setCached(untrackedPrefix + 'stat3', 'v3'); // Untracked

            const stats = cacheInstance.getLocalCacheStats();
            expect(stats.size).toBe(2); // Only tracked keys count
            expect(stats.keys).toEqual(expect.arrayContaining([trackedPrefix1 + 'stat1', trackedPrefix2 + 'stat2']));
            expect(stats.keys).not.toContain(untrackedPrefix + 'stat3');
        });

        it('getLocalValue: should return local value or undefined', async () => {
           const key = trackedPrefix1 + 'localKey';
           const value = 'localValue';
           expect(cacheInstance.getLocalValue(key)).toBeUndefined(); // Before set
           await cacheInstance.setCached(key, value);
           expect(cacheInstance.getLocalValue(key)).toBe(value);    // After set
           cacheInstance.clearLocalCache();
           expect(cacheInstance.getLocalValue(key)).toBeUndefined(); // After clear
        });
    });
});
