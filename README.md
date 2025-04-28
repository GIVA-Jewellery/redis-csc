# Redis Client-Side Caching for ioredis (BCAST Mode)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT) This library implements Redis 6+ Client-Side Caching using the `CLIENT TRACKING` command in **BCAST (Broadcast)** mode for the popular [`ioredis`](https://github.com/luin/ioredis) Node.js client.

It helps reduce latency and load on your Redis server by maintaining a local in-memory cache for specified key prefixes. The local cache is automatically invalidated when keys matching the tracked prefixes are modified in Redis by *other* clients, thanks to Redis Pub/Sub notifications.

## Key Features

* **Automatic In-Memory Caching:** Caches Redis key/value pairs locally within your Node.js application instance.
* **Prefix-Based Tracking (BCAST Mode):** Monitors changes to *any* key matching specified prefixes, regardless of whether the current client instance read the key.
* **Automatic Invalidation:** Uses Redis 6+ `CLIENT TRACKING` (BCAST mode) and Pub/Sub (`__redis__:invalidate` channel) to remove stale data from the local cache when changes occur in Redis.
* **Configurable Local TTL:** Set a time-to-live (TTL) specifically for the local in-memory cache, independent of the Redis key's TTL.
* **Standard Cache Interface:** Provides familiar methods like `getCached`, `setCached`, `mGetCached`, `mSetCached`, `delCached`.
* **Uses `ioredis`:** Built on top of the `ioredis` client. You provide your configured `ioredis` instance.
* **NOLOOP:** Prevents the client from receiving invalidation messages for changes it makes itself.

## Requirements

* **Node.js:** Version 14 or higher recommended.
* **Redis Server:** Version **6.0** or higher (required for `CLIENT TRACKING`).
* **`ioredis`:** This library requires `ioredis` as a peer dependency or direct dependency in your project.

## Installation

Assuming you save the provided code as `redisClientSideCache.js` within your project (e.g., in a `lib` folder):

```bash
# Install ioredis if you haven't already
npm install ioredis
# or
yarn add ioredis
````

## Usage

### Basic Setup

```javascript
const Redis = require('ioredis');
const { RedisClientSideCache } = require('redis-csc');

// Create your ioredis client
const redis = new Redis({
    host: 'localhost',
    port: 6379
});

// Initialize the client-side cache
const prefixes = ['user:', 'product:']; // Keys to track
const defaultExpiry = 3600; // 1 hour default expiry for Redis keys
const invalidationCallback = (invalidatedKeys) => {
    console.log('Keys invalidated:', invalidatedKeys);
};
const readyTimeoutMs = 5000; // 5 seconds timeout for initial connection
const localCacheTTL = 300; // 5 minutes local cache TTL

const cache = await RedisClientSideCache.create(
    redis,
    prefixes,
    defaultExpiry,
    invalidationCallback,
    readyTimeoutMs,
    localCacheTTL
);
```

### Constructor Parameters

1. `client` (Required): An initialized `ioredis` client instance
2. `prefixes` (Required): Array of key prefixes to track (e.g., `['user:', 'product:']`)
3. `defaultExpiry` (Optional): Default TTL in seconds for Redis keys (default: 1 week)
4. `listener` (Optional): Callback function for invalidation events
5. `readyTimeoutMs` (Optional): Connection timeout in milliseconds (default: 5000)
6. `localCacheTTL` (Optional): Local cache TTL in seconds (default: 300)

### Cache Operations

#### Get a Single Key

```javascript
const { data, cacheHits, cacheMisses } = await cache.getCached('user:123');
console.log(data); // The value or null if not found
console.log(cacheHits); // 1 if served from local cache, 0 if from Redis
console.log(cacheMisses); // 1 if fetched from Redis, 0 if from local cache
```

#### Set a Single Key

```javascript
// Set with default expiry
await cache.setCached('user:123', JSON.stringify({ name: 'John' }));

// Set with custom expiry (in seconds)
await cache.setCached('user:123', JSON.stringify({ name: 'John' }), 3600);
```

#### Get Multiple Keys

```javascript
const { data, cacheHits, cacheMisses } = await cache.mGetCached([
    'user:123',
    'user:456',
    'product:789'
]);
console.log(data); // Object with key-value pairs
console.log(cacheHits); // Number of keys served from local cache
console.log(cacheMisses); // Number of keys fetched from Redis
```

#### Set Multiple Keys

```javascript
const data = {
    'user:123': JSON.stringify({ name: 'John' }),
    'user:456': JSON.stringify({ name: 'Jane' })
};

// Set with default expiry
await cache.mSetCached(data);

// Set with custom expiry (in seconds)
await cache.mSetCached(data, 3600);
```

#### Delete Keys

```javascript
// Delete a single key
const deletedCount = await cache.delCached('user:123');

// Delete multiple keys
const deletedCount = await cache.delCached(['user:123', 'user:456']);
```

### Cache Management

#### Clear Local Cache

```javascript
cache.clearLocalCache();
```

#### Get Local Cache Statistics

```javascript
const stats = cache.getLocalCacheStats();
console.log(stats.size); // Number of keys in local cache
console.log(stats.keys); // Array of keys in local cache
```

#### Graceful Shutdown

```javascript
// Disconnect the cache (doesn't affect the main Redis client)
await cache.disconnect();

// Don't forget to quit your main Redis client when done
await redis.quit();
```

## How It Works

1. **Local Caching**: When you fetch a key using `getCached` or `mGetCached`, the library:
   - First checks the local in-memory cache
   - If not found locally, fetches from Redis
   - Stores the Redis response in local cache if it matches tracked prefixes

2. **Automatic Invalidation**: When any Redis client modifies a tracked key:
   - Redis sends an invalidation message via Pub/Sub
   - The library automatically removes the key from local cache
   - Subsequent requests fetch fresh data from Redis

3. **TTL Management**:
   - `defaultExpiry`: Controls how long keys persist in Redis
   - `localCacheTTL`: Controls how long keys persist in local memory
   - Local cache entries expire independently of Redis TTLs

## Best Practices

1. **Choose Prefixes Carefully**:
   - Be specific to avoid tracking unnecessary keys
   - Consider data access patterns and update frequency
   - Example: `user:profile:` instead of just `user:`

2. **Memory Management**:
   - Set appropriate `localCacheTTL` to prevent memory bloat
   - Monitor cache size using `getLocalCacheStats()`
   - Clear cache manually if needed using `clearLocalCache()`

3. **Error Handling**:
   - Wrap cache operations in try-catch blocks
   - Handle disconnections gracefully
   - Monitor invalidation events using the callback

## Limitations

1. Only works with Redis 6.0 or higher due to `CLIENT TRACKING` requirement
2. Requires two Redis connections (main + subscriber)
3. Local cache is not shared between different Node.js processes
4. Memory usage grows with number of cached keys

## License

MIT
