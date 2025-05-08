// redis-csc-performance.test.js

const IORedis = require('ioredis');
const { RedisClientSideCache, _waitUntilReady } = require('./RedisClientSideCache'); // Adjust path if necessary
const { performance } = require('perf_hooks');

// --- Configuration ---
const REDIS_CONFIG = {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: process.env.REDIS_PORT || 6379,
    // Add other Redis options if needed (e.g., password, db)
};

const TEST_PREFIX = 'perf_csc_test:';
const ITERATIONS_READ = 10000; // Number of read operations for averaging
const ITERATIONS_WRITE = 50;  // Number of write operations for averaging
const DEFAULT_EXPIRY_SECONDS = 60;
const LOCAL_CACHE_TTL_SECONDS = 300; // How long items stay in local memory cache

// Helper to generate unique keys
const generateKey = (id) => `${TEST_PREFIX}key_${id}`;
const generateValue = (id) => `value_for_key_${id}_${Math.random()}`;

describe('RedisClientSideCache Performance Comparison', () => {
    let directRedisClient;
    let cachingClientPrimary; // The client passed to RedisClientSideCache
    let cscInstance; // RedisClientSideCache instance

    beforeAll(async () => {
        // 1. Initialize Direct Redis Client (for baseline)
        directRedisClient = new IORedis(REDIS_CONFIG);
        await _waitUntilReady(directRedisClient, 10000); // Increased timeout for potentially slower CI environments
        console.log('Direct Redis client connected.');

        // 2. Initialize Redis Client for Client-Side Caching
        cachingClientPrimary = new IORedis(REDIS_CONFIG);
        // Note: RedisClientSideCache.create will duplicate this for its subscriber
        
        console.log('Attempting to create RedisClientSideCache instance...');
        cscInstance = await RedisClientSideCache.create(
            cachingClientPrimary,
            [TEST_PREFIX],
            DEFAULT_EXPIRY_SECONDS,
            (invalidatedKeys) => {
                // console.log('[PerfTest] Keys invalidated:', invalidatedKeys);
            },
            5000, // readyTimeoutMs
            LOCAL_CACHE_TTL_SECONDS
        );
        console.log('RedisClientSideCache instance created successfully.');

        // Clean up any old test keys from previous runs
        const keys = await directRedisClient.keys(`${TEST_PREFIX}*`);
        if (keys.length > 0) {
            await directRedisClient.del(keys);
            console.log(`Cleaned up ${keys.length} old test keys.`);
        }
    }, 30000); // Increased timeout for beforeAll

    afterAll(async () => {
        if (cscInstance) {
            console.log('Disconnecting RedisClientSideCache instance...');
            await cscInstance.disconnect(); // This handles its internal subscriber
            console.log('RedisClientSideCache instance disconnected.');
        }
        if (cachingClientPrimary && cachingClientPrimary.status !== 'end') {
            console.log('Disconnecting primary client for CSC...');
            await cachingClientPrimary.quit();
            console.log('Primary client for CSC disconnected.');
        }
        if (directRedisClient && directRedisClient.status !== 'end') {
            console.log('Disconnecting direct Redis client...');
            await directRedisClient.quit();
            console.log('Direct Redis client disconnected.');
        }
    }, 20000); // Increased timeout for afterAll

    // --- Helper function to measure and log performance ---
    async function measurePerformance(description, operationFn, iterations = 1) {
        let totalTime = 0;
        const timings = [];
        for (let i = 0; i < iterations; i++) {
            const start = performance.now();
            await operationFn(i); // Pass iteration number if needed for unique keys
            const end = performance.now();
            const duration = end - start;
            timings.push(duration);
            totalTime += duration;
        }
        const averageTime = totalTime / iterations;
        console.log(`PERF: ${description} - Avg: ${averageTime.toFixed(4)} ms (${iterations} iterations)`);
        // You could return averageTime or timings for assertions if needed
        return { averageTime, timings };
    }

    // --- Test Suites ---

    describe('1. Direct Redis Calls (Baseline)', () => {
        const key = generateKey('direct_get');
        const value = generateValue('direct_get');

        test(`GET operation (${ITERATIONS_READ} iterations)`, async () => {
            await directRedisClient.set(key, value); // Ensure key exists
            await measurePerformance(
                'Direct Redis GET',
                async () => directRedisClient.get(key),
                ITERATIONS_READ
            );
        });

        test(`MGET operation (${ITERATIONS_READ} iterations, 5 keys)`, async () => {
            const keys = [];
            const data = {};
            for (let i = 0; i < 5; i++) {
                const k = generateKey(`direct_mget_${i}`);
                keys.push(k);
                data[k] = generateValue(`direct_mget_${i}`);
            }
            await directRedisClient.mset(data); // Ensure keys exist
            await measurePerformance(
                'Direct Redis MGET (5 keys)',
                async () => directRedisClient.mget(keys),
                ITERATIONS_READ
            );
        });
        
        test(`SET operation (${ITERATIONS_WRITE} iterations)`, async () => {
            await measurePerformance(
                'Direct Redis SET',
                async (i) => directRedisClient.set(generateKey(`direct_set_${i}`), generateValue(i)),
                ITERATIONS_WRITE
            );
        });

        test(`MSET operation (${ITERATIONS_WRITE} iterations, 5 keys)`, async () => {
            const dataSet = {};
            for(let i=0; i<5; i++) {
                dataSet[generateKey(`direct_mset_batch_${i}`)] = generateValue(`direct_mset_batch_${i}`);
            }
            await measurePerformance(
                'Direct Redis MSET (5 keys)',
                async () => directRedisClient.mset(dataSet), // Using the same set of keys for mset for simplicity in iteration
                ITERATIONS_WRITE
            );
        });
    });

    describe('2. Client-Side Caching (CSC) Calls', () => {
        const missKey = generateKey('csc_get_miss');
        const missValue = generateValue('csc_get_miss');

        describe('2.1. Cache Miss (First Read, then Populates Cache)', () => {
            test(`getCached - MISS (${ITERATIONS_READ} iterations, new keys)`, async () => {
                // For misses, each iteration should use a new key to ensure it's a miss
                await measurePerformance(
                    'CSC getCached (MISS)',
                    async (i) => {
                        const currentKey = generateKey(`csc_get_miss_${i}`);
                        // Ensure it's not in Redis or set it now
                        await directRedisClient.set(currentKey, generateValue(`csc_get_miss_${i}`));
                        await cscInstance.getCached(currentKey);
                    },
                    ITERATIONS_READ
                );
            });

            test(`mGetCached - MISS (${ITERATIONS_READ} iterations, 5 new keys each)`, async () => {
                await measurePerformance(
                    'CSC mGetCached (5 keys, MISS)',
                    async (iter) => {
                        const keys = [];
                        const dataToSet = {};
                        for (let i = 0; i < 5; i++) {
                            const k = generateKey(`csc_mget_miss_${iter}_${i}`);
                            keys.push(k);
                            dataToSet[k] = generateValue(`csc_mget_miss_${iter}_${i}`);
                        }
                        await directRedisClient.mset(dataToSet); // Ensure keys are in Redis
                        await cscInstance.mGetCached(keys);
                    },
                    ITERATIONS_READ
                );
            });
        });

        describe('2.2. Cache Hit (Subsequent Reads from Local Cache)', () => {
            const hitKey = generateKey('csc_get_hit');
            const hitValue = generateValue('csc_get_hit');

            beforeAll(async () => {
                // Populate the cache for hitKey
                await cscInstance.setCached(hitKey, hitValue, DEFAULT_EXPIRY_SECONDS);
                // Fetch it once to ensure it's in the local cache of cscInstance
                await cscInstance.getCached(hitKey); 
                console.log(`Primed local cache for key: ${hitKey}`);

                // Populate for mGetCached hit test
                const mGetHitKeys = [];
                const mGetHitData = {};
                for (let i = 0; i < 5; i++) {
                    const k = generateKey(`csc_mget_hit_${i}`);
                    mGetHitKeys.push(k);
                    mGetHitData[k] = generateValue(`csc_mget_hit_${i}`);
                }
                await cscInstance.mSetCached(mGetHitData, DEFAULT_EXPIRY_SECONDS);
                await cscInstance.mGetCached(mGetHitKeys); // Prime local cache
                console.log(`Primed local cache for mGet keys: ${mGetHitKeys.join(', ')}`);
            });
            
            test(`getCached - HIT (${ITERATIONS_READ} iterations)`, async () => {
                await measurePerformance(
                    'CSC getCached (HIT)',
                    async () => cscInstance.getCached(hitKey),
                    ITERATIONS_READ
                );
            });

            test(`mGetCached - HIT (${ITERATIONS_READ} iterations, 5 keys)`, async () => {
                const keys = [];
                for (let i = 0; i < 5; i++) {
                    keys.push(generateKey(`csc_mget_hit_${i}`));
                }
                await measurePerformance(
                    'CSC mGetCached (5 keys, HIT)',
                    async () => cscInstance.mGetCached(keys),
                    ITERATIONS_READ
                );
            });
        });
        
        describe('2.3. Write Operations (Populates Cache)', () => {
            test(`setCached operation (${ITERATIONS_WRITE} iterations)`, async () => {
                await measurePerformance(
                    'CSC setCached',
                    async (i) => cscInstance.setCached(
                        generateKey(`csc_set_${i}`), 
                        generateValue(i), 
                        DEFAULT_EXPIRY_SECONDS
                    ),
                    ITERATIONS_WRITE
                );
            });

            test(`mSetCached operation (${ITERATIONS_WRITE} iterations, 5 keys)`, async () => {
                const dataSet = {};
                 for(let i=0; i<5; i++) {
                    dataSet[generateKey(`csc_mset_batch_${i}`)] = generateValue(`csc_mset_batch_${i}`);
                }
                await measurePerformance(
                    'CSC mSetCached (5 keys)',
                    async () => cscInstance.mSetCached(dataSet, DEFAULT_EXPIRY_SECONDS),
                    ITERATIONS_WRITE
                );
            });
        });
    });
});

