import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCorsHeaders, isCorsPreflightRequest } from '../../src/backend/cors.js';

test('allows credentialed CORS requests from the requesting origin', () => {
    const headers = createCorsHeaders({
        headers: { origin: 'https://client.example' },
        method: 'GET',
    });

    assert.equal(headers['access-control-allow-origin'], 'https://client.example');
    assert.equal(headers['access-control-allow-credentials'], 'true');
    assert.equal(headers.vary, 'Origin');
});

test('allows requested headers and methods on preflight responses', () => {
    const request = {
        headers: {
            'access-control-request-headers': 'authorization, content-type',
            'access-control-request-method': 'POST',
            origin: 'https://client.example',
        },
        method: 'OPTIONS',
    };
    const headers = createCorsHeaders(request, { vary: 'Accept-Encoding' });
    const allowedHeaders = headers['access-control-allow-headers']
        .toLowerCase()
        .split(', ')
        .sort();

    assert.equal(isCorsPreflightRequest(request), true);
    assert.deepEqual(allowedHeaders, ['authorization', 'content-type', 'cookie']);
    assert.equal(headers['access-control-allow-methods'].includes('POST'), true);
    assert.equal(headers.vary, 'Accept-Encoding, Origin');
});

test('explicitly allows Authorization and Cookie when no headers are requested', () => {
    const headers = createCorsHeaders({
        headers: { 'access-control-request-method': 'GET' },
        method: 'OPTIONS',
    });

    assert.equal(headers['access-control-allow-headers'], 'Authorization, Cookie');
});
