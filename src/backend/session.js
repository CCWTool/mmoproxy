import { randomUUID } from 'node:crypto';
import { createClient } from 'redis';

const sessionTtlSeconds = 60 * 60 * 24;
const sessionTtlMilliseconds = sessionTtlSeconds * 1000;
globalThis.kv ??= {};

let redisClient = null;

const initRedisClient = async () => {
    if (!redisClient) {
        redisClient = createClient({
            url: process.env.REDIS_URL || 'redis://localhost:6379',
        });

        redisClient.on('error', (err) => {
            console.error('Redis client error:', err);
        });
        
        await redisClient.connect();
    }
};

const getRedisClient = async () => {
    if (!redisClient) {
        await initRedisClient();
    }

    return redisClient;
};

const createUserSession = async (userId) => {
    const sessionId = randomUUID();
    const sessionKey = `session:${sessionId}`;

    if (process.env.REDIS_ENABLED === 'true') {
        const client = await getRedisClient();
        await client.set(sessionKey, userId, { EX: sessionTtlSeconds });
    } else {
        globalThis.kv[sessionKey] = {
            userId,
            expiresAt: Date.now() + sessionTtlMilliseconds,
        };
    }

    return sessionId;
};

const validateUserSession = async (sessionId) => {
    const sessionKey = `session:${sessionId}`;

    if (process.env.REDIS_ENABLED === 'true') {
        const client = await getRedisClient();
        return client.get(sessionKey);
    }

    const session = globalThis.kv[sessionKey];
    if (!session) {
        return null;
    }

    if (session.expiresAt <= Date.now()) {
        delete globalThis.kv[sessionKey];
        return null;
    }

    return session.userId;
};

const deleteUserSession = async (sessionId) => {
    const sessionKey = `session:${sessionId}`;

    if (process.env.REDIS_ENABLED === 'true') {
        const client = await getRedisClient();
        await client.del(sessionKey);
    } else {
        delete globalThis.kv[sessionKey];
    }
};

export { createUserSession, validateUserSession, deleteUserSession };