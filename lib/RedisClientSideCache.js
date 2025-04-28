

function _log(...args) {
    //console.log(...args);
}

/**
 * Helper function to wait for ioredis client readiness.
 * @private
 * @param {import('ioredis').Redis} client - The ioredis client instance.
 * @param {number} [timeoutMs=5000] - Timeout in milliseconds.
 * @returns {Promise<void>} Resolves when ready, rejects on error or timeout.
 */
function _waitUntilReady(client, timeoutMs = 50000) {
    return new Promise((resolve, reject) => {
        if (!client || typeof client.status !== 'string' || typeof client.connect !== 'function') {
             return reject(new Error("Invalid ioredis client provided to _waitUntilReady."));
        }
        if (client.status === 'ready') {
            return resolve();
        }
        if (client.status === 'end') {
            return reject(new Error("ioredis client has already ended."));
        }

        let readyListener = null;
        let errorListener = null;
        let endListener = null;
        let timeout = null;

        const cleanup = () => {
            if (readyListener) client.removeListener('ready', readyListener);
            if (errorListener) client.removeListener('error', errorListener);
            if (endListener) client.removeListener('end', endListener); // Handle client ending unexpectedly
            if (timeout) clearTimeout(timeout);
        };

        // Listener for the 'ready' event
        readyListener = () => {
            _log(`_waitUntilReady: Client status became 'ready'.`); // Debug log
            cleanup();
            resolve();
        };

        // Listener for the 'error' event during the wait period
        errorListener = (err) => {
            console.error(`_waitUntilReady: Client emitted 'error' while waiting:`, err); // Debug log
            cleanup();
            // Reject with a more specific error message
            reject(new Error(`ioredis client connection error while waiting for ready: ${err.message}`));
        };

        // Listener for the 'end' event
        endListener = () => {
            console.warn(`_waitUntilReady: Client status became 'end' while waiting.`); // Debug log
            cleanup();
            reject(new Error("ioredis client ended unexpectedly while waiting for ready status."));
        };

        // Set a timeout for the readiness check
        timeout = setTimeout(() => {
            console.warn(`_waitUntilReady: Timeout (${timeoutMs}ms) waiting for ready. Current status: ${client.status}`); // Debug log
            cleanup();
            reject(new Error(`Timeout (${timeoutMs}ms) waiting for ioredis client to become ready. Current status: ${client.status}`));
        }, timeoutMs);

        // Attach the listeners
        client.once('ready', readyListener);
        client.once('error', errorListener);
        client.once('end', endListener);

        // If the client is not already connecting, trigger connection.
        // ioredis usually connects automatically unless lazyConnect is true.
        // This check might be redundant depending on ioredis setup, but ensures connection attempt.
        if (client.status !== 'connecting' && client.status !== 'connect' && client.status !== 'reconnecting') {
             _log(`_waitUntilReady: Client status is '${client.status}', explicitly calling connect().`); // Debug log
             client.connect().catch(err => {
                 // This catch is important if connect() itself rejects immediately
                 console.error(`_waitUntilReady: Explicit connect() call failed:`, err);
                 // cleanup(); // Cleanup might already be called by error listener
                 reject(new Error(`ioredis client explicit connect() failed: ${err.message}`));
             });
        } else {
             _log(`_waitUntilReady: Client status is '${client.status}', connection already in progress or established.`); // Debug log
        }
    });
}


/**
 * Implements Redis 6+ Client-Side Caching for ioredis.
 * Uses the CLIENT TRACKING command with BCAST mode and prefix filtering.
 * Requires two Redis connections: one for commands, one dedicated subscriber for invalidation messages.
 */
class RedisClientSideCache {
    // --- Private instance fields ---
    #localCache = {}; // In-memory cache store
    #localCacheKeyTTLMap = {}; //manage the age of local cache keys
    #localCacheTTL = 300*1000; // Default TTL for local cache keys (5 minutes)
    #prefixes = []; // Key prefixes to manage in the local cache
    #clientCachingTriggered = false; // Flag to prevent duplicate setup
    /** @type {import('ioredis').Redis | null} */ // JSDoc type hint for ioredis
    #redisClient = null; // Primary client for GET/SET etc.
    /** @type {import('ioredis').Redis | null} */ // JSDoc type hint for ioredis
    #subscriber = null; // Dedicated client for PUBSUB invalidation messages
    #defaultExpiry = 60 * 60 * 24 * 7; // Default expiry for keys set via mSetCached (1 week)
    #messageListener = null; // Stores the bound message listener function for removal
    #invalidationCallback = null; // User-provided callback for invalidation events

    /**
     * Private constructor: Use the static `create` method for instantiation.
     * Assumes client is an ioredis instance.
     * @param {import('ioredis').Redis} client The primary ioredis client instance.
     * @param {string[]} prefixes Array of key prefixes to cache locally.
     * @param {number} [defaultExpiry] Optional default expiry (in seconds).
     * @param {Function} [listener] Optional callback for invalidated keys.
     */
    constructor(client, prefixes, defaultExpiry, listener, cacheTTL) {
        // Basic check for ioredis client characteristics - ensure it's a valid instance
        if (!client || typeof client.duplicate !== 'function' || typeof client.subscribe !== 'function' || typeof client.call !== 'function') {
            throw new Error("Provided client does not appear to be a valid ioredis client instance.");
        }
        this.#redisClient = client;
        // Create a dedicated connection for subscribing to invalidation messages
        // This prevents blocking the main client with PUBSUB commands.
        this.#subscriber = client.duplicate();
        this.#prefixes = prefixes;
        this.#defaultExpiry = (typeof defaultExpiry === 'number' && defaultExpiry >= 0)
            ? defaultExpiry
            : (60 * 60 * 24 * 7); // Default to 1 week
        this.#invalidationCallback = listener;
        this.#localCacheTTL = (typeof cacheTTL === 'number' && cacheTTL > 0) ? cacheTTL : this.#localCacheTTL;

         // Add error handlers to the subscriber client immediately
         this.#subscriber.on('error', (err) => {
            console.error('RedisClientSideCache: Subscriber client error:', err);
        });
    }

    /**
     * Creates, initializes, and returns a ready-to-use RedisClientSideCache instance using ioredis.
     * Waits for client connections to be ready and sets up CLIENT TRACKING for invalidation.
     * IMPORTANT: Assumes the provided `client` is managed externally (e.g., connection errors, reconnection).
     * This class manages the lifecycle of its internal `subscriber` client.
     *
     * @param {import('ioredis').Redis} client The primary ioredis client instance. Should be instantiated. Connection managed externally.
     * @param {string[]} prefixes Array of key prefixes to cache locally. E.g., ['user:', 'product:']
     * @param {number} [defaultExpiry] Optional default expiry for mSetCached (in seconds). Defaults to 1 week.
     * @param {Function} [listener] Optional callback function invoked with invalidated keys array. Signature: (invalidatedKeys: string[]) => void
     * @param {number} [readyTimeoutMs=5000] Timeout in milliseconds to wait for clients to connect initially.
     * @param {number} [localCacheTTL=300] Timeout in seconds for refreshing the cache.
     * @returns {Promise<RedisClientSideCache>} A Promise resolving to the initialized RedisClientSideCache instance.
     * @throws {Error} If initialization fails (e.g., client connection timeout, Redis command error).
     */
    static async create(client, prefixes, defaultExpiry, listener, readyTimeoutMs = 5000, localCacheTTL = 300) {
        if (!Array.isArray(prefixes)) {
            throw new Error("prefixes must be an array of strings.");
        }
         // Basic check for ioredis client characteristics
        if (!client || typeof client.status !== 'string' || typeof client.call !== 'function') {
            throw new Error("A valid ioredis client instance must be provided.");
        }

        // Create the instance (this also duplicates the client for the subscriber)
        const instance = new RedisClientSideCache(client, prefixes, defaultExpiry, listener, localCacheTTL);

        try {
            // 1. Wait for both clients to be ready.
            // It's crucial because we need to send commands (CLIENT ID, CLIENT TRACKING).
            // We wait for the main client *even though its lifecycle is external*
            // because we need it ready for the initial TRACKING command.
            _log("RedisClientSideCache: Waiting for main ioredis client to be ready...");
            await _waitUntilReady(instance.#redisClient, readyTimeoutMs);
            _log("RedisClientSideCache: Main ioredis client is ready.");

            // Wait for the internally managed subscriber client
            _log("RedisClientSideCache: Waiting for subscriber ioredis client to be ready...");
            await _waitUntilReady(instance.#subscriber, readyTimeoutMs);
            _log("RedisClientSideCache: Subscriber ioredis client is ready.");

            // 2. Setup tracking and subscription logic
            await instance.#setupTrackingAndSubscription();

            _log("RedisClientSideCache: Instance successfully created and initialized.");
            return instance;
        } catch (err) {
            console.error("RedisClientSideCache: Failed to initialize:", err);
            // Attempt to clean up the *internally managed* subscriber client if creation failed
            // Do NOT disconnect the main client here, as it's managed externally.
            await instance.disconnectInternalResources(true); // Pass flag indicating partial state
            // Rethrow the initialization error to the caller
            throw new Error(`Failed to create RedisClientSideCache: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    /**
     * @private
     * Internal helper for setting up CLIENT TRACKING and PUBSUB subscription using ioredis methods.
     * Assumes both #redisClient and #subscriber are connected and ready.
     * @returns {Promise<void>}
     * @throws {Error} If Redis commands fail.
     */
    async #setupTrackingAndSubscription() {
        if (this.#clientCachingTriggered) {
            console.warn("RedisClientSideCache: Client tracking setup already triggered. Skipping.");
            return;
        }
        // Redundant checks, but good practice before sending commands
        if (this.#subscriber?.status !== 'ready') {
             throw new Error("Internal Error: Subscriber client is not ready before setting up tracking.");
        }
        if (this.#redisClient?.status !== 'ready') {
             throw new Error("Internal Error: Main client is not ready before setting up tracking.");
        }

        this.#clientCachingTriggered = true; // Set flag early to prevent race conditions
        _log("RedisClientSideCache: Setting up Redis client-side caching tracking (BCAST mode)...");

        try {
            // Get the Client ID of the subscriber connection. We redirect invalidation messages to this connection.
            // Using .call() for commands not directly mapped by ioredis.
            const clientId = await this.#subscriber.call('CLIENT', 'ID');
             if (!clientId) {
                throw new Error("Failed to get Client ID for the subscriber connection.");
            }
            _log(`RedisClientSideCache: Subscriber client ID: ${clientId}`);

            // Construct the CLIENT TRACKING arguments
            // ON: Enable tracking
            // REDIRECT <clientId>: Send invalidation messages to this specific client ID (our subscriber)
            // BCAST: Broadcast mode - track keys based on prefixes, even if not read by this client
            // PREFIX <prefix>: Specify prefixes to track (repeat for multiple)
            // NOLOOP: Don't send invalidations for changes made by this *main* client connection
            const trackingArgs = ["ON", "REDIRECT", String(clientId)];
            if (this.#prefixes.length > 0) {
                trackingArgs.push("BCAST");
                this.#prefixes.forEach(p => {
                    if (p) { // Ensure prefix is not empty
                       trackingArgs.push("PREFIX");
                       trackingArgs.push(p);
                    }
                });
            } else {
                 console.warn("RedisClientSideCache: No prefixes specified for BCAST tracking.");
                 return; // Skip BCAST if no prefixes are provided
            }
            trackingArgs.push("NOLOOP"); // Essential to avoid self-invalidation loops

            _log("RedisClientSideCache: Sending CLIENT TRACKING command:", ["CLIENT", "TRACKING", ...trackingArgs].join(' '));
            // Send the command using the *main* client connection
            const trackingResult = await this.#redisClient.call("CLIENT", "TRACKING", ...trackingArgs);
            _log("RedisClientSideCache: CLIENT TRACKING setup result:", trackingResult); // Should be 'OK'
            if (trackingResult !== 'OK') {
                throw new Error(`CLIENT TRACKING command failed. Result: ${trackingResult}`);
            }

            // --- Setup Subscriber ---

            // Define the message listener function (bound to 'this' instance)
            // This function will handle incoming invalidation messages.
            this.#messageListener = (channel, message) => {
                // We only care about the specific invalidation channel Redis sends messages to
                // when using CLIENT TRACKING redirection.
                if (channel !== '__redis__:invalidate') {
                    // Ignore messages from other channels
                    return;
                }

                if (!message) {
                    return;// Ignore empty messages
                }

                let msgArr = message.split(','); // redis sends keys as a comma-separated string
                for (const key of msgArr) {
                    if (key && this.#qualifiesPrefix(key)) {
                        delete this.#localCache[key]; // Remove from local cache
                        delete this.#localCacheKeyTTLMap[key]; // Remove key age tracking
                    }
                }
            };

            // Attach the listener to the 'message' event on the subscriber client
            this.#subscriber.on('message', this.#messageListener);

            // Subscribe the subscriber client to the invalidation channel.
            // This channel is used by Redis when CLIENT TRACKING redirection is enabled.
            await this.#subscriber.subscribe('__redis__:invalidate');
            _log("RedisClientSideCache: Subscriber client successfully subscribed to '__redis__:invalidate' channel.");

        } catch (err) {
            console.error("RedisClientSideCache: Failed to set up client-side caching subscription internals:", err);
            this.#clientCachingTriggered = false; // Reset flag on failure

            // Cleanup: Remove listener if it was attached before the error occurred
            if (this.#messageListener && this.#subscriber) {
                try {
                    this.#subscriber.off('message', this.#messageListener);
                } catch (offErr){ console.warn("RedisClientSideCache: Error removing message listener during setup failure cleanup", offErr); }
                this.#messageListener = null;
            }
             // Attempt to unsubscribe if subscribe command was sent before error
             if (this.#subscriber && typeof this.#subscriber.unsubscribe === 'function') {
                 try {
                     await this.#subscriber.unsubscribe('__redis__:invalidate');
                 } catch (unsubErr) { console.warn("RedisClientSideCache: Error unsubscribing during setup failure cleanup", unsubErr); }
             }

            // Rethrow the error to ensure the static `create` method fails clearly
            throw err;
        }
    }

    /**
     * @private
     * Checks if a key matches any of the configured prefixes.
     * @param {string} key The key to check.
     * @returns {boolean} True if the key starts with any of the prefixes, false otherwise.
     */
    #qualifiesPrefix(key) {
        if (typeof key !== 'string' || this.#prefixes.length === 0) {
            return false; // Only cache strings, and only if prefixes are defined
        }
        return this.#prefixes.some(p => key.startsWith(p));
    }

    #setLocalValue(key, value, expiry) {
        if (this.#qualifiesPrefix(key) === false) {
            //console.log(`RedisClientSideCache: Key "${key}" does not match any prefixes. Not caching locally.`);
            return; // Only cache keys that match the prefixes
        }
        //console.log(`RedisClientSideCache: Setting local cache for key "${key}" with value "${value}".`);
        let expiryms = expiry && expiry > 0 ? expiry *1000 : this.#localCacheTTL; // Convert to milliseconds
        this.#localCache[key] = value; // Store the string value directly
        this.#localCacheKeyTTLMap[key] = Date.now() + (expiryms > this.#localCacheTTL ? this.#localCacheTTL : expiryms) ; // Store the expiry time
    }

    #getLocalValue(key) {
        if (this.#localCacheKeyTTLMap[key] && this.#localCacheKeyTTLMap[key] < Date.now()) {
            delete this.#localCache[key]; // Remove expired key
            delete this.#localCacheKeyTTLMap[key]; // Remove key age tracking
            return null; // Key expired
        }
        //we are not checking for quilify prefix as this should be taken care of when setting value in local cache
        return this.#localCache[key]; // Return the cached value
    }

    #deleteLocalValue(key) {
        delete this.#localCache[key]; // Remove expired key
        delete this.#localCacheKeyTTLMap[key]; // Remove key age tracking
    }

    // --- Caching Methods ---

    /**
     * Retrieves a value from Redis using the provided key.
     * Checks the local cache first, then Redis.
     * Caches the value locally if it matches a prefix.
     * 
     * @param {string} key The key to retrieve from Redis.
     * @returns {Promise<{data: string | null, cacheHits: number, cacheMisses: number}>} Object containing the value and cache hit statistics.
     * @throws {Error} If input is invalid or Redis command fails.
     */
    async getCached(key) {
        if (typeof key !== 'string') {
            throw new Error("Input 'key' must be a string.");
        }
        if (!this.#redisClient || this.#redisClient.status !== 'ready') {
            throw new Error("Redis client is not connected or ready.");
        }

        const value = this.#getLocalValue(key); // Check local cache first
        if (value) {
            return {data: value, cacheHits: 1, cacheMisses: 0}; // Return the cached value
        }

        // If not in local cache, fetch from Redis
        try {
            const value = await this.#redisClient.get(key);
            this.#setLocalValue(key, value); // Update local cache
            // Only cache locally if the value is not null AND it matches a prefix 
            if (value !== null && this.#qualifiesPrefix(key)) {
                this.#localCache[key] = value; // Store the string value directly
                this.#localCacheKeyTTLMap[key] = Date.now() + this.#localCacheTTL; // Store the creation time
            }
            return {data: value, cacheHits: 0, cacheMisses: 1}; // Return the value from Redis
        } catch (err) {
            console.error("RedisClientSideCache: Error fetching key from Redis in getCached:", err);
            throw new Error(`Failed to fetch key from Redis: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    /**
     * Sets a key-value pair in Redis and updates the local cache for keys matching the configured prefixes.
     * Optionally sets expiry using `EXPIRE`.
     * 
     * @param {string} key The key to set in Redis.
     * @param {string | number | Buffer} value The value to set. Will be coerced to a string.
     * @param {number} [expiry] Optional expiry time in seconds. If not provided or invalid, uses the instance's default expiry. If 0 or negative, expiry is not set.
     * @returns {Promise<string>} Result from Redis SET command (ioredis usually returns 'OK').
     * @throws {Error} If input is invalid or Redis command fails.
     * */
    async setCached(key, value, expiry = undefined) {
        if (typeof key !== 'string') {
            throw new Error("Input 'key' must be a string.");
        }
        if (!this.#redisClient || this.#redisClient.status !== 'ready') {
            throw new Error("Redis client is not connected or ready.");
        }

        // Ensure value is suitable for Redis (string/buffer/number)
        if (value === null || value === undefined) {
            throw new Error("Input 'value' must be a non-null, non-undefined string, buffer, or number.");
        }
        const stringValue = String(value); // Coerce to string for consistency

        try {
            // Set expiry if specified
            const expireSecs = (typeof expiry === 'number' && expiry >= 0) ? expiry : this.#defaultExpiry;
            let ret = null;
            // Set the value in Redis
            if (expireSecs > 0) {
                // Use SETEX for setting value with expiry
                ret = await this.#redisClient.set(key, stringValue, 'EX', expireSecs);
            } else {
                // Use SET for setting value without expiry
                ret = await this.#redisClient.set(key, stringValue);
            }
            this.#setLocalValue(key, stringValue, expireSecs); // Update local cache
            return ret;
        } catch (err) {
            console.error("RedisClientSideCache: Error setting key in Redis in setCached:", err);
            throw new Error(`Failed to set key in Redis: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    /**
     * Retrieves multiple keys, utilizing the local cache first.
     * Fetches missing keys from Redis using `MGET`.
     * Populates the local cache with fetched keys that match configured prefixes.
     * 
     * @param {string[]} keys Array of keys to retrieve.
     * @returns {Promise<{ data: Record<string, string | null>, cacheHits: number, cacheMisses: number }>}
     * An object containing:
     * - `data`: A key-value map of the results (value is `null` if key doesn't exist).
     * - `cacheHits`: Number of keys served directly from the local cache.
     * - `cacheMisses`: Number of keys that had to be fetched from Redis.
     * @throws {Error} If input is invalid or Redis fetch fails.
     */
    async mGetCached(keys) {
        if (!Array.isArray(keys)) {
            throw new Error("Input 'keys' must be an array of strings.");
        }
        if (!this.#redisClient || this.#redisClient.status !== 'ready') {
            throw new Error("Redis client is not connected or ready.");
        }

        const results = {};
        const keysToFetchFromRedis = [];
        let localHits = 0;

        // 1. Check local cache first
        for (const key of keys) {
            if (typeof key !== 'string') {
                console.warn(`RedisClientSideCache: Non-string key encountered in mGetCached: ${key}. Skipping.`);
                results[key] = null; // Or handle as an error depending on desired strictness
                continue;
            }
            // Check if the key qualifies AND exists in the local cache
            const val = this.#getLocalValue(key); // Check local cache first
            if (val) {
                results[key] = val;
                localHits++;
            } else {
                keysToFetchFromRedis.push(key);
                results[key] = null;
            }
        }

        const misses = keysToFetchFromRedis.length;
        // 2. Fetch missing keys from Redis
        if (misses > 0) {
            try {
                // ioredis client.mget returns (string | null)[] in the same order as input keys
                const redisValues = await this.#redisClient.mget(keysToFetchFromRedis);

                // 3. Process Redis results and update local cache
                for (let i = 0; i < keysToFetchFromRedis.length; i++) {
                    const key = keysToFetchFromRedis[i];
                    const value = redisValues[i]; // value can be string or null
                    results[key] = value; // Update the result map
                    this.#setLocalValue(key, value); // Update local cache
                }
            } catch (err) {
                console.error("RedisClientSideCache: Error fetching keys from Redis in mGetCached:", err);
                // How to handle partial failures? Current approach throws, losing all results.
                // Alternative: Return partial results with an error indicator.
                throw new Error(`Failed to fetch keys from Redis: ${err instanceof Error ? err.message : String(err)}`);
            }
        }

        return { data: results, cacheHits: localHits, cacheMisses: misses };
    }

    /**
     * Sets multiple key-value pairs in Redis using `MSET` and updates the local cache
     * for keys matching the configured prefixes. Optionally sets expiry using `EXPIRE`.
     *
     * @param {Record<string, string | number | Buffer>} data An object map of key-value pairs to set. Values will be coerced to strings.
     * @param {number} [expiry] Optional expiry time in seconds. If not provided or invalid, uses the instance's default expiry. If 0 or negative, expiry is not set.
     * @returns {Promise<string>} Result from Redis MSET command (ioredis usually returns 'OK').
     * @throws {Error} If input is invalid or Redis command fails.
     */
    async mSetCached(data, expiry) {
        if (typeof data !== 'object' || data === null || Array.isArray(data)) {
            throw new Error("Invalid data argument. Must be an object map of key-value pairs.");
        }
        if (!this.#redisClient || this.#redisClient.status !== 'ready') {
            throw new Error("Redis client is not connected or ready.");
        }

        const keys = Object.keys(data);
        if (keys.length === 0) {
            return 'OK'; // Nothing to set
        }

        const msetData = {}; // Prepare data for ioredis mset

        // 1. Update local cache and prepare data for Redis MSET
        for (const key of keys) {
             const value = data[key];
             // Ensure value is suitable for Redis (string/buffer/number)
             if (value === null || value === undefined) {
                 console.warn(`RedisClientSideCache: Skipping key "${key}" in mSetCached due to null/undefined value.`);
                 continue; // Skip this key-value pair
             }
             const stringValue = String(value); // Coerce to string for consistency
             msetData[key] = stringValue; // Add to object for MSET
        }

         if (Object.keys(msetData).length === 0) {
             _log("RedisClientSideCache: No valid key-value pairs remaining after filtering in mSetCached.");
             return 'OK';
         }

        try {
            // 2. Execute MSET command
            // ioredis client.mset(object) returns 'OK' on success
            const setResult = await this.#redisClient.mset(msetData);

            // 3. Set expiry if specified, 0 expiry means no expiry
            const expireSecs = (typeof expiry === 'number' && expiry >= 0) ? expiry : this.#defaultExpiry;
            // Store new values in local cache
            for (const [key, value] of Object.entries(msetData)) {
                this.#setLocalValue(key, value, expireSecs);
            }

            if (typeof expireSecs === 'number' && expireSecs > 0) {
                // Use MULTI/EXEC pipeline for setting multiple expiries efficiently
                const multi = this.#redisClient.multi();
                const keysToSetExpiry = Object.keys(msetData); // Get keys that were actually set
                keysToSetExpiry.forEach(k => multi.expire(k, expireSecs));
                const expiryResults = await multi.exec(); // Returns array of results like [[null, 1], [null, 0], ...]

                // Optional: Check expiry results for errors (each element in expiryResults is [error, result])
                expiryResults.forEach(([err, res], index) => {
                    if (err) {
                        console.warn(`RedisClientSideCache: Error setting expiry for key "${keysToSetExpiry[index]}":`, err);
                    }
                    // res should be 1 if expiry was set, 0 if key didn't exist (shouldn't happen right after MSET)
                });
            }
            return setResult; // Return the result of MSET ('OK')
        } catch (err) {
            console.error("RedisClientSideCache: Error setting keys/expiry in Redis mSetCached:", err);
            // Important: If MSET fails, the local cache might be inconsistent.
            // Strategy: Attempt to remove the keys we *tried* to set from local cache on error?
            for (const key of Object.keys(msetData)) {
                 if (this.#qualifiesPrefix(key)) {
                     delete this.#localCache[key]; // Attempt rollback on error
                 }
            }
            throw new Error(`Failed to set keys/expiry in Redis: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    /**
     * Deletes one or more keys from Redis using `DEL` and removes them from the local cache.
     *
     * @param {string | string[]} keys A single key or an array of keys to delete.
     * @returns {Promise<number>} The number of keys successfully deleted from Redis.
     * @throws {Error} If input is invalid or Redis command fails.
     */
    async delCached(keys) {
        const keysToDelete = Array.isArray(keys) ? keys : [keys]; // Ensure it's an array

        if (!keysToDelete.every(k => typeof k === 'string')) {
             throw new Error("Invalid keys argument. Must be a string or an array of strings.");
        }
        if (keysToDelete.length === 0) {
            return 0; // Nothing to delete
        }
        if (!this.#redisClient || this.#redisClient.status !== 'ready') {
            throw new Error("Redis client is not connected or ready.");
        }

        // 1. Remove keys from local cache immediately
        let locallyRemovedCount = 0;
        for (const key of keysToDelete) {
            // Check prefix qualification? No, delete regardless of prefix if it exists locally.
            // The user explicitly asked to delete this key.
            if (Object.prototype.hasOwnProperty.call(this.#localCache, key)) {
                delete this.#localCache[key];
                delete this.#localCacheKeyTTLMap[key]; // Remove key age tracking
                locallyRemovedCount++;
            }
        }
        // _log(`RedisClientSideCache: Removed ${locallyRemovedCount} keys locally.`);

        try {
            // 2. Delete keys from Redis
            // ioredis client.del([...keys]) returns the number of keys deleted
            const redisDeleteCount = await this.#redisClient.del(keysToDelete);
            return redisDeleteCount;
        } catch (err) {
            console.error("RedisClientSideCache: Error deleting keys from Redis in delCached:", err);
            // Local cache is already updated. Should we try to revert? Difficult.
            // Best to report the error and potentially have inconsistent state.
            throw new Error(`Failed to delete keys from Redis: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    /**
     * Clears the entire local cache for all tracked prefixes.
     * Does NOT affect Redis data.
     */
    clearLocalCache() {
        this.#localCache = {};
        this.#localCacheKeyTTLMap = {}; // Clear the local cache
    }


    /**
     * @private
     * Disconnects the internally managed subscriber client and removes listeners.
     * Should be called by the public `disconnect` method or during error cleanup in `create`.
     * @param {boolean} [calledFromError=false] - Internal flag for logging/behavior adjustments.
     * @returns {Promise<void>}
     */
    async disconnectInternalResources(calledFromError = false) {
         _log(`RedisClientSideCache: Disconnecting internal resources... ${calledFromError ? '(Called from error path)' : ''}`);

        // Check if the main client is likely still connected enough to send a command
        // You might adjust this check based on how you manage the main client's lifecycle
        if (this.#redisClient.status === 'ready' || this.#redisClient.status === 'connect') {
            _log("RedisClientSideCache: Attempting to turn off CLIENT TRACKING on main client...");
            try {
                const offResult = await this.#redisClient.call('CLIENT', 'TRACKING', 'OFF');
                _log(`RedisClientSideCache: CLIENT TRACKING OFF result: ${offResult}`); // Should be 'OK'
                if (offResult !== 'OK') {
                    // Log a warning if turning off tracking failed, but proceed with cleanup
                    console.warn(`RedisClientSideCache: CLIENT TRACKING OFF command did not return 'OK'. Result: ${offResult}`);
                }
            } catch (trackOffErr) {
                console.warn("RedisClientSideCache: Error sending CLIENT TRACKING OFF to main client:", trackOffErr);
                // Continue cleanup even if turning off tracking fails
            }
        } else {
            console.warn(`RedisClientSideCache: Skipping CLIENT TRACKING OFF as main client status is '${this.#redisClient.status}'. Tracking might remain active on Redis server.`);
        }

         // 1. Remove message listener
         if (this.#messageListener && this.#subscriber && typeof this.#subscriber.off === 'function') {
             try {
                 this.#subscriber.off('message', this.#messageListener);
                 _log("RedisClientSideCache: Removed message listener.");
             } catch (offErr) {
                 console.warn("RedisClientSideCache: Error removing message listener during disconnect:", offErr);
             }
             this.#messageListener = null; // Clear reference
         }

         // 2. Unsubscribe the subscriber client (best effort)
         // Check status before unsubscribing if not called from error path, otherwise try anyway
         const shouldAttemptUnsubscribe = this.#clientCachingTriggered && this.#subscriber && typeof this.#subscriber.unsubscribe === 'function';
         const isSubConnected = this.#subscriber?.status === 'ready' || this.#subscriber?.status === 'connect';

         if (shouldAttemptUnsubscribe && (calledFromError || isSubConnected)) {
             try {
                 _log("RedisClientSideCache: Attempting to unsubscribe subscriber client...");
                 await this.#subscriber.unsubscribe("__redis__:invalidate");
                 _log("RedisClientSideCache: Unsubscribed from channel.");
             } catch (err) {
                 // Log error but continue disconnect process
                 console.warn("RedisClientSideCache: Error during unsubscribe:", err.message || err);
             }
         } else if (shouldAttemptUnsubscribe) {
              _log(`RedisClientSideCache: Skipping unsubscribe attempt. Status: ${this.#subscriber?.status}`);
         }

         // 3. Disconnect the subscriber client
         if (this.#subscriber && typeof this.#subscriber.quit === 'function') {
             _log("RedisClientSideCache: Quitting subscriber client...");
             try {
                 // Don't wait indefinitely if called from error, but still initiate quit
                 const quitPromise = this.#subscriber.quit();
                 if (!calledFromError) {
                     await quitPromise; // Wait for graceful shutdown if possible
                     _log("RedisClientSideCache: Subscriber client quit successfully.");
                 } else {
                     quitPromise.catch(err => console.warn("RedisClientSideCache: Error during subscriber quit (in error path):", err));
                     _log("RedisClientSideCache: Initiated subscriber quit during error cleanup (no await).");
                 }
             } catch (err) {
                 console.warn("RedisClientSideCache: Error quitting subscriber client:", err);
                 // If quit fails, try disconnect for a forceful close
                  if (typeof this.#subscriber.disconnect === 'function') {
                      _log("RedisClientSideCache: Attempting forceful disconnect of subscriber...");
                      this.#subscriber.disconnect();
                  }
             }
         }

         // 4. Reset state
         this.#subscriber = null; // Release reference
         this.#clientCachingTriggered = false;
         this.#localCache = {}; // Clear local cache on disconnect
         _log("RedisClientSideCache: Internal resources disconnected and state reset.");
    }

    /**
     * Gracefully disconnects the internal subscriber ioredis client using `quit()`.
     * Removes the message listener and unsubscribes.
     * **IMPORTANT:** This method **does not** disconnect the main `redisClient` passed during creation,
     * as its lifecycle is managed externally. The caller is responsible for managing the main client.
     *
     * @returns {Promise<void>}
     */
    async disconnect() {
        _log("RedisClientSideCache: Disconnecting internal subscriber client and cleaning up...");
        await this.disconnectInternalResources(false); // Call internal disconnect logic
        // No need to touch this.#redisClient here
        _log("RedisClientSideCache: Disconnect complete. Remember to manage the main client separately.");
    }


    /**
     * Gets statistics about the local in-memory cache.
     * @returns {{ size: number, keys: string[] }} Object containing the number of keys and an array of the keys currently held in the local cache.
     */
    getLocalCacheStats() {
        const keys = Object.keys(this.#localCache);
        return { size: keys.length, keys: keys };
    }

     /**
      * Retrieves the current value for a single key directly from the local cache, if it exists.
      * Does not check Redis. Returns undefined if the key is not in the local cache.
      * @param {string} key The key to retrieve from the local cache.
      * @returns {string | undefined} The cached value, or undefined if not found locally.
      */
     getLocalValue(key) {
        return this.#getLocalValue(key); // Ensure the key is in the local cache
     }

     clearLocalCache() {
        this.#localCache = {}; // Clear the local cache
        this.#localCacheKeyTTLMap = {}; // Clear the local cache key TTL map
     }
}

// Export the class using CommonJS syntax
module.exports = { RedisClientSideCache, _waitUntilReady};
