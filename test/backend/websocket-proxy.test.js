import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { test } from 'node:test';
import {
    getRandomPoolCookie,
    login,
    loginNumberPoolAccount,
    removeNumberPoolAccount,
    validateNumberPoolAccount,
    validateNumberPoolAccounts,
} from '../../src/backend/number-pool.js';
import { attachProxy, buildUpstreamHeaders, readProxyHeaders } from '../../src/backend/proxy.js';

test('builds a Cookie header from a randomly selected pool account', async () => {
    const cookie = await getRandomPoolCookie({
        async getRandomNumberPoolEntry() {
            return { uuid: 'account-1', token: 'token-value', password: null };
        },
    });

    assert.equal(cookie, 'token=token-value; cookie-user-id=account-1');
});

test('reports an empty number pool instead of forwarding without a Cookie', async () => {
    await assert.rejects(
        getRandomPoolCookie({ async getRandomNumberPoolEntry() { return null; } }),
        { code: 'NUMBER_POOL_EMPTY' },
    );
});

test('logs in to CCW, fetches the student OID, and caches the complete Cookie', async () => {
    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, options) => {
        calls.push({ url, options });
        if (url === 'https://sso.ccw.site/web/auth/login-by-password') {
            return {
                ok: true,
                headers: {
                    getSetCookie() {
                        return ['other=value; Path=/', 'token=ccw-token; Path=/; HttpOnly'];
                    },
                },
            };
        }
        return {
            ok: true,
            async json() {
                return { body: { studentOid: 'student-oid' } };
            },
        };
    };

    try {
        const cookie = await login('login-account-1', 'password-1');
        assert.equal(cookie, 'token=ccw-token; cookie-user-id=student-oid');
        assert.equal(await login('login-account-1', 'password-1'), cookie);
        assert.equal(calls.length, 2);
        assert.equal(calls[0].options.method, 'POST');
        assert.equal(calls[0].options.headers['User-Agent'].includes('Chrome/146.0.0.0'), true);
        assert.deepEqual(JSON.parse(calls[0].options.body), {
            loginKey: 'login-account-1',
            clientCode: 'STUDY_COMMUNITY',
            password: 'password-1',
            extra: '{"device":"Windows 10","browser":"Chrome 146","scene":null}',
        });
        assert.equal(calls[1].url, 'https://community-web.ccw.site/students/profile');
        assert.deepEqual(JSON.parse(calls[1].options.body), { studentNumber: 'login-account-1' });
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('persists the login token and student OID returned by CCW', async () => {
    const originalFetch = globalThis.fetch;
    const updates = [];
    globalThis.fetch = async (url) => url === 'https://sso.ccw.site/web/auth/login-by-password'
        ? {
            ok: true,
            headers: { getSetCookie: () => ['token=pool-login-token; Path=/'] },
        }
        : {
            ok: true,
            async json() {
                return { body: { studentOid: 'pool-student-oid' } };
            },
        };

    try {
        const cookie = await getRandomPoolCookie({
            async getRandomNumberPoolEntry() {
                return {
                    uuid: 'login-pool-account',
                    token: null,
                    password: 'pool-password',
                    cookieUserId: null,
                };
            },
            async updateNumberPoolToken(...values) {
                updates.push(values);
                return true;
            },
        });

        assert.equal(cookie, 'token=pool-login-token; cookie-user-id=pool-student-oid');
        assert.deepEqual(updates, [['login-pool-account', 'pool-login-token', 'pool-student-oid']]);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('fails login when CCW does not issue a token cookie', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
        ok: true,
        headers: { getSetCookie: () => ['session=value; Path=/'] },
    });

    try {
        await assert.rejects(login('missing-token-account', 'password'), { code: 'LOGIN_FAILED' });
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('immediately logs in with fresh credentials and saves the token and validation status', async () => {
    const originalFetch = globalThis.fetch;
    const calls = [];
    const updates = [];
    globalThis.fetch = async (url) => {
        calls.push(url);
        return url === 'https://sso.ccw.site/web/auth/login-by-password'
            ? { ok: true, headers: { getSetCookie: () => ['token=fresh-login-token; Path=/'] } }
            : { ok: true, async json() { return { body: { studentOid: 'fresh-student-oid' } }; } };
    };

    try {
        const result = await loginNumberPoolAccount({
            uuid: 'immediate-login-account',
            password: 'account-password',
        }, {
            async updateNumberPoolToken(...values) { updates.push(['token', ...values]); return true; },
            async updateNumberPoolValidation(...values) { updates.push(['validation', ...values]); return true; },
        });
        assert.deepEqual(result, { token: 'fresh-login-token', cookieUserId: 'fresh-student-oid' });
        assert.deepEqual(calls, [
            'https://sso.ccw.site/web/auth/login-by-password',
            'https://community-web.ccw.site/students/profile',
        ]);
        assert.deepEqual(updates, [
            ['token', 'immediate-login-account', 'fresh-login-token', 'fresh-student-oid'],
            ['validation', 'immediate-login-account', true, ''],
        ]);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('removing a pool account also clears its cached login Cookie', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => url === 'https://sso.ccw.site/web/auth/login-by-password'
        ? { ok: true, headers: { getSetCookie: () => ['token=before-removal; Path=/'] } }
        : { ok: true, async json() { return { body: { studentOid: 'student-oid' } }; } };
    let removed = false;
    const database = {
        async deleteNumberPoolAccount(uuid) {
            assert.equal(uuid, 'cached-account');
            removed = true;
            return true;
        },
        async getRandomNumberPoolEntry() {
            return { uuid: 'cached-account', password: 'password', token: null };
        },
        async updateNumberPoolToken() { return true; },
    };

    try {
        await login('cached-account', 'password');
        assert.equal(await removeNumberPoolAccount('cached-account', database), true);
        assert.equal(removed, true);
        const callsBeforeRetry = [];
        globalThis.fetch = async (url) => {
            callsBeforeRetry.push(url);
            return { ok: true, headers: { getSetCookie: () => ['token=after-removal; Path=/'] } };
        };
        await assert.rejects(getRandomPoolCookie(database), { code: 'PROFILE_FAILED' });
        assert.equal(callsBeforeRetry.length, 2);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('validates a token with the student detail endpoint and persists its status', async () => {
    const originalFetch = globalThis.fetch;
    const calls = [];
    const updates = [];
    globalThis.fetch = async (url, options) => {
        calls.push({ url, options });
        return { status: 200 };
    };

    try {
        const result = await validateNumberPoolAccount({
            uuid: 'token-account',
            token: 'valid-token',
            password: null,
            cookieUserId: 'student-oid',
        }, {
            async updateNumberPoolValidation(...values) { updates.push(values); },
        });
        assert.deepEqual(result, { valid: true, info: '' });
        assert.equal(calls[0].url, 'https://community-web.ccw.site/students/self/detail');
        assert.equal(calls[0].options.headers.Cookie, 'token=valid-token; cookie-user-id=student-oid');
        assert.deepEqual(updates, [['token-account', true, '']]);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('retries invalid password accounts and records the login response message', async () => {
    const originalFetch = globalThis.fetch;
    const calls = [];
    const updates = [];
    globalThis.fetch = async (url, options) => {
        calls.push({ url, options });
        if (url === 'https://community-web.ccw.site/students/self/detail') return { status: 401 };
        return {
            headers: { getSetCookie: () => [] },
            async json() { return { msg: '密码错误或账号被封禁' }; },
        };
    };

    try {
        const result = await validateNumberPoolAccount({
            uuid: 'password-account',
            token: 'expired-token',
            password: 'password',
            cookieUserId: null,
        }, {
            async updateNumberPoolValidation(...values) { updates.push(values); },
        });
        assert.deepEqual(result, { valid: false, info: '密码错误或账号被封禁' });
        assert.equal(calls.length, 2);
        assert.equal(calls[1].url, 'https://sso.ccw.site/web/auth/login-by-password');
        assert.deepEqual(updates, [['password-account', false, '密码错误或账号被封禁']]);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('accepts password login when Set-Cookie is present and saves the refreshed credentials', async () => {
    const originalFetch = globalThis.fetch;
    const updates = [];
    globalThis.fetch = async (url) => {
        if (url === 'https://community-web.ccw.site/students/self/detail') return { status: 403 };
        if (url === 'https://sso.ccw.site/web/auth/login-by-password') {
            return { headers: { getSetCookie: () => ['token=new-token; Path=/'] } };
        }
        return {
            ok: true,
            async json() { return { body: { studentOid: 'new-student-oid' } }; },
        };
    };

    try {
        const result = await validateNumberPoolAccount({
            uuid: 'password-account',
            token: 'expired-token',
            password: 'password',
            cookieUserId: null,
        }, {
            async updateNumberPoolToken(...values) { updates.push(['token', ...values]); },
            async updateNumberPoolValidation(...values) { updates.push(['validation', ...values]); },
        });
        assert.deepEqual(result, { valid: true, info: '' });
        assert.deepEqual(updates, [
            ['token', 'password-account', 'new-token', 'new-student-oid'],
            ['validation', 'password-account', true, ''],
        ]);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('marks token-only accounts invalid without trying password login', async () => {
    const originalFetch = globalThis.fetch;
    const calls = [];
    const updates = [];
    globalThis.fetch = async (url) => {
        calls.push(url);
        return { status: 403 };
    };

    try {
        const result = await validateNumberPoolAccount({
            uuid: 'token-only-account',
            token: 'expired-token',
            password: null,
            cookieUserId: null,
        }, {
            async updateNumberPoolValidation(...values) { updates.push(values); },
        });
        assert.deepEqual(result, { valid: false, info: '仅 token 账号无法自动重新登录。' });
        assert.deepEqual(calls, ['https://community-web.ccw.site/students/self/detail']);
        assert.deepEqual(updates, [['token-only-account', false, '仅 token 账号无法自动重新登录。']]);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('continues startup validation after a per-account network error', async () => {
    const originalFetch = globalThis.fetch;
    const updates = [];
    globalThis.fetch = async () => { throw new Error('network unavailable'); };

    try {
        await validateNumberPoolAccounts({
            async getNumberPoolAccounts() {
                return [{ uuid: 'offline-account', token: 'offline-token', password: null }];
            },
            async updateNumberPoolValidation(...values) { updates.push(values); },
        });
        assert.deepEqual(updates, [['offline-account', false, 'network unavailable']]);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('forwards ordinary headers but replaces credentials and WebSocket handshake headers', () => {
    const headers = buildUpstreamHeaders({
        headers: {
            authorization: 'Bearer client-secret',
            cookie: 'client-cookie=1',
            connection: 'Upgrade',
            host: 'proxy.example',
            'sec-websocket-key': 'client-key',
            'x-request-id': 'request-1',
        },
    }, { 'X-Proxy-Mode': 'on' }, 'token=pool-token; cookie-user-id=account-1');

    assert.deepEqual(headers, {
        'x-request-id': 'request-1',
        'x-proxy-mode': 'on',
        cookie: 'token=pool-token; cookie-user-id=account-1',
    });
});

test('rejects custom overrides for generated handshake and credential headers', () => {
    assert.throws(() => readProxyHeaders('{"Cookie":"caller-value"}'), /cannot override Cookie/);
    assert.throws(() => buildUpstreamHeaders({ headers: {} }, { cookie: 'caller-value' }, 'token=pool-token'), /cannot override cookie/);
});

test('requires WS_PROXY_HEADERS to be a JSON object of string values', () => {
    assert.throws(() => readProxyHeaders('[]'), /must be a JSON object/);
    assert.throws(() => readProxyHeaders('{"x-count":1}'), /string values/);
});

test('proxies HTTP requests with pool cookies and the same filtered headers', async () => {
    let upstreamRequest;
    const upstreamServer = createServer((request, response) => {
        const chunks = [];
        request.on('data', (chunk) => chunks.push(chunk));
        request.on('end', () => {
            upstreamRequest = {
                body: Buffer.concat(chunks).toString(),
                headers: request.headers,
                method: request.method,
                url: request.url,
            };
            response.writeHead(200, { 'Content-Type': 'text/plain' });
            response.end('upstream response');
        });
    });
    await new Promise((resolve) => upstreamServer.listen(0, '127.0.0.1', resolve));

    let tokenValidationCalls = 0;
    let chargeCalls = 0;
    let poolLookupCalls = 0;
    const server = createServer();
    attachProxy(server, {
        async validateBearerToken(token) {
            tokenValidationCalls += 1;
            assert.equal(token, 'valid-token');
            return 42;
        },
        async chargeUserMinute(userId) {
            chargeCalls += 1;
            assert.equal(userId, 42);
            return true;
        },
        async getRandomNumberPoolEntry() {
            poolLookupCalls += 1;
            return { uuid: 'http-account', token: 'pool-token', password: null };
        },
    }, {
        host: '127.0.0.1',
        port: 9989,
        upstreamUrl: 'wss://ws.example.com',
        httpUpstreamUrl: `http://127.0.0.1:${upstreamServer.address().port}/ignored-prefix?drop=1`,
        configuredHeaders: { 'X-Proxy-Mode': 'on' },
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

    try {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/data?query=1`, {
            method: 'POST',
            headers: {
                Authorization: 'Bearer valid-token',
                Cookie: 'client-cookie=must-not-forward',
                'Content-Type': 'text/plain',
                'X-Request-Id': 'request-1',
            },
            body: 'request body',
        });
        assert.equal(response.status, 200);
        assert.equal(await response.text(), 'upstream response');
        assert.deepEqual({
            body: upstreamRequest.body,
            method: upstreamRequest.method,
            url: upstreamRequest.url,
        }, {
            body: 'request body',
            method: 'POST',
            url: '/api/data?query=1',
        });
        assert.equal(upstreamRequest.headers.cookie, 'token=pool-token; cookie-user-id=http-account');
        assert.equal(upstreamRequest.headers.authorization, undefined);
        assert.equal(upstreamRequest.headers['x-request-id'], 'request-1');
        assert.equal(upstreamRequest.headers['x-proxy-mode'], 'on');
        assert.equal(tokenValidationCalls, 1);
        assert.equal(chargeCalls, 1);
        assert.equal(poolLookupCalls, 1);

        const unauthorizedResponse = await fetch(`http://127.0.0.1:${server.address().port}/unauthorized`);
        assert.equal(unauthorizedResponse.status, 401);
        assert.equal(chargeCalls, 1);
        assert.equal(poolLookupCalls, 1);
    } finally {
        await Promise.all([
            new Promise((resolve) => server.close(resolve)),
            new Promise((resolve) => upstreamServer.close(resolve)),
        ]);
    }
});

test('rejects unauthenticated WebSocket upgrades before consulting the number pool', async () => {
    let tokenValidationCalls = 0;
    const server = createServer();
    attachProxy(server, {
        async validateBearerToken() {
            tokenValidationCalls += 1;
            return null;
        },
    }, {
        host: '127.0.0.1',
        port: 9989,
        upstreamUrl: 'wss://ws.example.com',
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

    async function requestUpgrade(authorization) {
        return new Promise((resolve, reject) => {
            const socket = connect(server.address().port, '127.0.0.1');
            let response = '';
            socket.once('connect', () => {
                socket.write(
                    'GET /socket HTTP/1.1\r\n' +
                    'Host: localhost\r\n' +
                    'Upgrade: websocket\r\n' +
                    'Connection: Upgrade\r\n' +
                    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
                    'Sec-WebSocket-Version: 13\r\n' +
                    (authorization ? `Authorization: ${authorization}\r\n` : '') +
                    '\r\n',
                );
            });
            socket.on('data', (chunk) => { response += chunk; });
            socket.once('end', () => resolve(response));
            socket.once('error', reject);
        });
    }

    try {
        assert.match(await requestUpgrade(), /^HTTP\/1\.1 401 Unauthorized/);
        assert.equal(tokenValidationCalls, 0);
        assert.match(await requestUpgrade('Bearer invalid-key'), /^HTTP\/1\.1 401 Unauthorized/);
        assert.equal(tokenValidationCalls, 1);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});

test('rejects an authenticated WebSocket upgrade when the user cannot pay the first minute', async () => {
    let poolLookupCalls = 0;
    const server = createServer();
    attachProxy(server, {
        async validateBearerToken() { return 42; },
        async chargeUserMinute() { return false; },
        async getRandomNumberPoolEntry() {
            poolLookupCalls += 1;
            return null;
        },
    }, {
        host: '127.0.0.1',
        port: 9989,
        upstreamUrl: 'wss://ws.example.com',
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

    try {
        const response = await new Promise((resolve, reject) => {
            const socket = connect(server.address().port, '127.0.0.1');
            let body = '';
            socket.once('connect', () => {
                socket.write(
                    'GET /socket HTTP/1.1\r\n' +
                    'Host: localhost\r\n' +
                    'Upgrade: websocket\r\n' +
                    'Connection: Upgrade\r\n' +
                    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
                    'Sec-WebSocket-Version: 13\r\n' +
                    'Authorization: Bearer valid-token\r\n\r\n',
                );
            });
            socket.on('data', (chunk) => { body += chunk; });
            socket.once('end', () => resolve(body));
            socket.once('error', reject);
        });
        assert.match(response, /^HTTP\/1\.1 402 Payment Required/);
        assert.equal(poolLookupCalls, 0);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});
