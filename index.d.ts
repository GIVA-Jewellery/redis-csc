// index.d.ts
import { Redis } from 'ioredis';

export declare namespace RedisClientSideCache {
    interface CreateOptions {
        defaultExpiry?: number;
        listener?: (invalidatedKeys: string[]) => void;
        readyTimeoutMs?: number;
    }

    interface CacheStats {
        size: number;
        keys: string[];
    }

     interface MGetResult {
        data: Record<string, string | null>;
        cacheHits: number;
        cacheMisses: number;
    }
}

export declare class RedisClientSideCache {
    private constructor(client: Redis, prefixes: string[], defaultExpiry?: number, listener?: Function);

    static create(
        client: Redis,
        prefixes: string[],
        defaultExpiry?: number,
        listener?: (invalidatedKeys: string[]) => void,
        readyTimeoutMs?: number
    ): Promise<RedisClientSideCache>;

    static create(
        client: Redis,
        prefixes: string[],
        options?: RedisClientSideCache.CreateOptions // Overload for options object
    ): Promise<RedisClientSideCache>;


    getCached(key: string): Promise<string | null>;

    setCached(key: string, value: string | Buffer, expiry?: number): Promise<string>;

    mGetCached(keys: string[]): Promise<RedisClientSideCache.MGetResult>;

    mSetCached(data: Record<string, string | number | Buffer>, expiry?: number): Promise<string>;

    delCached(keys: string | string[]): Promise<number>;

    clearLocalCache(): void;

    disconnect(): Promise<void>;

    getLocalCacheStats(): RedisClientSideCache.CacheStats;

    getLocalValue(key: string): string | undefined;
}
