import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
    createUserSession,
    deleteUserSession,
    validateUserSession,
} from '../../src/backend/session.js';

const originalKv = globalThis.kv;
const originalRedisEnabled = process.env.REDIS_ENABLED;

before(() => {
    delete process.env.REDIS_ENABLED;
    globalThis.kv = {};
});

after(() => {
    if (originalRedisEnabled === undefined) {
        delete process.env.REDIS_ENABLED;
    } else {
        process.env.REDIS_ENABLED = originalRedisEnabled;
    }

    if (originalKv === undefined) {
        delete globalThis.kv;
    } else {
        globalThis.kv = originalKv;
    }
});

test('stores, validates, and deletes sessions in globalThis.kv', async () => {
    const sessionId = await createUserSession(42);

    assert.equal(await validateUserSession(sessionId), 42);
    await deleteUserSession(sessionId);
    assert.equal(await validateUserSession(sessionId), null);
});

test('treats expired in-memory sessions as invalid', async () => {
    const sessionId = await createUserSession(42);
    globalThis.kv[`session:${sessionId}`].expiresAt = Date.now() - 1;

    assert.equal(await validateUserSession(sessionId), null);
    assert.equal(globalThis.kv[`session:${sessionId}`], undefined);
});
