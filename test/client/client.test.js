import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { connect } from 'node:net';
import { once } from 'node:events';
import { test } from 'node:test';
import { createClientServer } from '../../src/client/index.js';

async function listen(server) {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return server.address().port;
}

async function close(server) {
    server.close();
    await once(server, 'close');
}

test('adds the configured bearer token to local HTTP requests', async () => {
    let upstreamRequest;
    const upstream = createHttpServer((request, response) => {
        const chunks = [];
        request.on('data', (chunk) => chunks.push(chunk));
        request.on('end', () => {
            upstreamRequest = {
                authorization: request.headers.authorization,
                body: Buffer.concat(chunks).toString(),
                path: request.url,
            };
            response.writeHead(201, { 'Content-Type': 'text/plain' });
            response.end('proxied');
        });
    });
    const upstreamPort = await listen(upstream);
    const client = createClientServer({
        serverUrl: `http://127.0.0.1:${upstreamPort}`,
        token: 'local-secret',
        port: 0,
    });
    const clientPort = await listen(client);

    try {
        const response = await fetch(`http://127.0.0.1:${clientPort}/api/example?value=1`, {
            body: 'request body',
            headers: { Authorization: 'Bearer attacker-token' },
            method: 'POST',
        });
        assert.equal(response.status, 201);
        assert.equal(await response.text(), 'proxied');
        assert.deepEqual(upstreamRequest, {
            authorization: 'Bearer local-secret',
            body: 'request body',
            path: '/api/example?value=1',
        });
    } finally {
        await close(client);
        await close(upstream);
    }
});

test('adds the configured bearer token to local WebSocket upgrades', async () => {
    let authorization;
    let upstreamSocket;
    const upstream = createHttpServer();
    upstream.on('upgrade', (request, socket) => {
        authorization = request.headers.authorization;
        upstreamSocket = socket;
        socket.write(
            'HTTP/1.1 101 Switching Protocols\r\n' +
            'Connection: Upgrade\r\n' +
            'Upgrade: websocket\r\n' +
            '\r\n',
        );
        socket.on('data', (data) => socket.write(data));
    });
    const upstreamPort = await listen(upstream);
    const client = createClientServer({
        serverUrl: `http://127.0.0.1:${upstreamPort}`,
        token: 'websocket-secret',
        port: 0,
    });
    const clientPort = await listen(client);
    let clientSocket;

    try {
        clientSocket = connect(clientPort, '127.0.0.1');
        const responsePromise = new Promise((resolve, reject) => {
            clientSocket.once('data', resolve);
            clientSocket.once('error', reject);
        });
        clientSocket.write(
            'GET /socket HTTP/1.1\r\n' +
            `Host: 127.0.0.1:${clientPort}\r\n` +
            'Connection: Upgrade\r\n' +
            'Upgrade: websocket\r\n' +
            'Sec-WebSocket-Version: 13\r\n' +
            'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
            'Authorization: Bearer attacker-token\r\n' +
            '\r\n',
        );

        const response = (await responsePromise).toString();
        assert.match(response, /^HTTP\/1\.1 101 Switching Protocols/);
        assert.equal(authorization, 'Bearer websocket-secret');
    } finally {
        clientSocket?.destroy();
        upstreamSocket?.destroy();
        await Promise.all([close(client), close(upstream)]);
    }
});
