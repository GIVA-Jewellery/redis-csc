// index.d.ts

// Import necessary types from ioredis
import { Redis, RedisOptions } from 'ioredis';
// Buffer is typically available globally in Node.js environments with @types/node
// If not, you might need: import { Buffer } from 'buffer';

/**
 * Options for creating a RedisClientSideCache instance.
 * Corresponds to parameters of the static `create` method.
 */
export interface RedisClientSideCacheOptions {
    /** The primary ioredis client instance. Should be connected or connecting. Managed externally. */
    client: Redis;
    /** Array of key prefixes to cache locally and track via BCAST mode. E.g., ['user:', 'product:'] */
    prefixes: string[];
    /** Optional default expiry for keys set via setCached/mSetCached (in seconds). Defaults to 1 week (604800s). Set 0 for no expiry. */
    defaultExpiry?: number;
    /** Optional callback function invoked with an array of invalidated keys received from Redis. */
    listener?: (invalidatedKeys: string[]) => void;
    /** Optional timeout in milliseconds to wait for the internal subscriber client to connect initially. Defaults to 5000ms. */
    readyTimeoutMs?: number;
    /** Optional Time-to-live in seconds for items stored in the local in-memory cache. Defaults to 300s (5 minutes). */
    localCacheTTL?: number;
}

/**
 * Represents the result structure for single-key get operations.
 */
export interface CacheGetResult {
    /** The retrieved data (string) or null if the key doesn't exist. */
    data: string | null;
    /** Number of times the data was served from the local cache (0 or 1 for single get). */
    cacheHits: number;
    /** Number of times the data had to be fetched from Redis (0 or 1 for single get). */
    cacheMisses: number;
}

/**
 * Represents the result structure for multi-key get operations.
 */
export interface CacheMGetResult {
    /** A key-value map of the results. Value is null if a key doesn't exist. */
    data: Record<string, string | null>;
    /** Number of keys served directly from the local cache. */
    cacheHits: number;
    /** Number of keys that had to be fetched from Redis. */
    cacheMisses: number;
}

/**
 * Implements Redis 6+ Client-Side Caching for ioredis using BCAST mode.
 * Maintains a local in-memory cache that is invalidated based on key prefixes.
 *
 * Use the static `RedisClientSideCache.create()` method for instantiation.
 */
export declare class RedisClientSideCache {
    /**
     * Private constructor. Use the static `create` method for instantiation.
     * @private
     */
    private constructor(client: Redis, prefixes: string[], defaultExpiry?: number, listener?: Function, cacheTTL?: number);

    /**
     * Creates, initializes, and returns a ready-to-use RedisClientSideCache instance.
     * Waits for client connections to be ready and sets up CLIENT TRACKING for invalidation.
     *
     * @param client The primary ioredis client instance. Should be connected or connecting. Connection managed externally.
     * @param prefixes Array of key prefixes to cache locally. E.g., ['user:', 'product:']
     * @param defaultExpiry Optional default expiry for setCached/mSetCached (in seconds). Defaults to 1 week. Set 0 for no expiry.
     * @param listener Optional callback function invoked with invalidated keys array. Signature: (invalidatedKeys: string[]) => void
     * @param readyTimeoutMs Optional timeout in milliseconds to wait for clients to connect initially. Defaults to 5000ms.
     * @param localCacheTTL Optional Time-to-live in seconds for items stored in the local in-memory cache. Defaults to 300s.
     * @returns A Promise resolving to the initialized RedisClientSideCache instance.
     * @throws {Error} If initialization fails (e.g., client connection timeout, Redis command error).
     */
    static create(
        client: Redis,
        prefixes: string[],
        defaultExpiry?: number,
        listener?: (invalidatedKeys: string[]) => void,
        readyTimeoutMs?: number,
        localCacheTTL?: number
    ): Promise<RedisClientSideCache>;

    /**
     * Retrieves a value from Redis using the provided key.
     * Checks the local cache first (respecting local TTL), then Redis.
     * Caches the value locally if it matches a tracked prefix and is not null.
     *
     * @param key The key to retrieve from Redis.
     * @returns Promise resolving to an object containing the value and cache hit statistics.
     * @throws {Error} If input is invalid or Redis command fails.
     */
    getCached(key: string): Promise<CacheGetResult>;

    /**
     * Sets a key-value pair in Redis and updates/adds to the local cache
     * if the key matches one of the configured prefixes.
     * Optionally sets expiry using `EXPIRE`.
     *
     * @param key The key to set in Redis.
     * @param value The value to set. Numbers will be coerced to strings.
     * @param expiry Optional expiry time in seconds. If not provided or invalid, uses the instance's default expiry. If 0 or negative, expiry is not set on Redis key.
     * @returns Promise resolving to the result from Redis SET command (usually 'OK').
     * @throws {Error} If input is invalid or Redis command fails.
     */
    setCached(key: string, value: string | number | Buffer, expiry?: number): Promise<string>;

    /**
     * Retrieves multiple keys, utilizing the local cache first (respecting local TTL).
     * Fetches missing keys from Redis using `MGET`.
     * Populates the local cache with fetched keys that match configured prefixes and are not null.
     *
     * @param keys Array of keys to retrieve.
     * @returns Promise resolving to an object containing:
     * - `data`: A key-value map of the results (value is `null` if key doesn't exist).
     * - `cacheHits`: Number of keys served directly from the local cache.
     * - `cacheMisses`: Number of keys that had to be fetched from Redis.
     * @throws {Error} If input is invalid or Redis fetch fails.
     */
    mGetCached(keys: string[]): Promise<CacheMGetResult>;

    /**
     * Sets multiple key-value pairs in Redis using `MSET` and updates the local cache
     * for keys matching the configured prefixes. Optionally sets expiry using `EXPIRE`.
     *
     * @param data An object map of key-value pairs to set. Values will be coerced to strings. e.g., { "key1": "val1", "key2": 123 }
     * @param expiry Optional expiry time in seconds for all keys in the batch. If not provided or invalid, uses the instance's default expiry. If 0 or negative, expiry is not set on Redis keys.
     * @returns Promise resolving to the result from Redis MSET command (usually 'OK').
     * @throws {Error} If input is invalid or Redis command fails.
     */
    mSetCached(data: Record<string, string | number | Buffer>, expiry?: number): Promise<string>;

    /**
     * Deletes one or more keys from Redis using `DEL` and removes them from the local cache.
     *
     * @param keys A single key string or an array of key strings to delete.
     * @returns Promise resolving to the number of keys successfully deleted from Redis.
     * @throws {Error} If input is invalid or Redis command fails.
     */
    delCached(keys: string | string[]): Promise<number>;

    /**
     * Clears the entire local in-memory cache for this instance.
     * Does NOT affect Redis data.
     */
    clearLocalCache(): void;

    /**
     * Gracefully disconnects the internal subscriber ioredis client used for invalidations.
     * Removes listeners and unsubscribes from the invalidation channel.
     * **IMPORTANT:** This method does NOT disconnect the main `redisClient` passed during creation.
     * The caller is responsible for managing the main client's lifecycle.
     *
     * @returns Promise resolving when internal resources are disconnected.
     */
    disconnect(): Promise<void>;

    /**
     * Gets statistics about the local in-memory cache.
     * @returns Object containing the number of keys and an array of the keys currently held in the local cache.
     */
    getLocalCacheStats(): { size: number; keys: string[] };

     /**
      * Retrieves the current value for a single key directly from the local cache, if it exists.
      * Does not check Redis or local TTL. Returns undefined if the key is not in the local cache.
      * Useful for inspecting cache state.
      * @param key The key to retrieve from the local cache.
      * @returns The cached string value, or undefined if not found locally.
      */
     getLocalValue(key: string): string | undefined;
}

/**
 * Helper function to wait for an ioredis client connection to reach the 'ready' state.
 * @param client The ioredis client instance.
 * @param timeoutMs Optional timeout in milliseconds. Defaults to 50000ms.
 * @returns Promise that resolves when the client is ready, or rejects on error or timeout.
 * @throws {Error} If client is invalid, an error occurs during connection, or timeout is reached.
 */
export declare function _waitUntilReady(client: Redis, timeoutMs?: number): Promise<void>;
