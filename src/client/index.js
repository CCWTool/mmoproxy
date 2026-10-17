import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const hopByHopHeaders = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'proxy-connection',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
]);

function validateConfiguration(serverUrl, token) {
    if (typeof serverUrl !== 'string' || !serverUrl.trim()) {
        throw new Error('MMOPROXY_SERVER_URL is required (for example, http://proxy.example.com:9989)');
    }
    if (typeof token !== 'string' || !token || /\s/.test(token)) {
        throw new Error('MMOPROXY_TOKEN is required and must not contain whitespace');
    }

    let target;
    try {
        target = new URL(serverUrl);
    } catch (error) {
        throw new Error('MMOPROXY_SERVER_URL must be a valid http:// or https:// URL', { cause: error });
    }
    if ((target.protocol !== 'http:' && target.protocol !== 'https:')
        || target.username || target.password
        || (target.pathname !== '/' && target.pathname !== '')
        || target.search || target.hash) {
        throw new Error('MMOPROXY_SERVER_URL must be an http:// or https:// origin without a path or credentials');
    }
    return target;
}

function filterRequestHeaders(headers, isWebSocket) {
    const filtered = {};
    for (const [name, value] of Object.entries(headers)) {
        const normalizedName = name.toLowerCase();
        const isWebSocketHeader = normalizedName === 'connection'
            || normalizedName === 'upgrade'
            || normalizedName.startsWith('sec-websocket-');
        if (normalizedName === 'host'
            || normalizedName === 'authorization'
            || (hopByHopHeaders.has(normalizedName) && !(isWebSocket && isWebSocketHeader))
            || (normalizedName.startsWith('sec-websocket-') && !isWebSocket)) {
            continue;
        }
        if (value !== undefined) filtered[normalizedName] = value;
    }
    return filtered;
}

function filterResponseHeaders(headers) {
    const filtered = {};
    for (const [name, value] of Object.entries(headers)) {
        if (!hopByHopHeaders.has(name.toLowerCase())) filtered[name] = value;
    }
    return filtered;
}

function writeError(response, status, message) {
    if (response.destroyed) return;
    if (response.headersSent) {
        response.destroy();
        return;
    }
    const body = `${message}\n`;
    response.writeHead(status, {
        'Content-Length': Buffer.byteLength(body),
        'Content-Type': 'text/plain; charset=utf-8',
    });
    response.end(body);
}

function writeSocketError(socket, status, message) {
    if (socket.destroyed) return;
    const body = `${message}\n`;
    socket.end(
        `HTTP/1.1 ${status} ${message}\r\n` +
        'Connection: close\r\n' +
        'Content-Type: text/plain; charset=utf-8\r\n' +
        `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    );
}

function serializeHeaders(rawHeaders) {
    let result = '';
    for (let index = 0; index < rawHeaders.length; index += 2) {
        result += `${rawHeaders[index]}: ${rawHeaders[index + 1]}\r\n`;
    }
    return result;
}

function createClientServer({
    serverUrl,
    token,
    port = 15432,
} = {}) {
    const target = validateConfiguration(serverUrl, token);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error('port must be an integer between 0 and 65535');
    }

    const makeRequest = target.protocol === 'https:' ? httpsRequest : httpRequest;
    const authorization = `Bearer ${token}`;

    const server = createHttpServer((request, response) => {
        const headers = filterRequestHeaders(request.headers, false);
        headers.authorization = authorization;

        const proxyRequest = makeRequest(target, {
            headers,
            method: request.method,
            path: request.url,
        }, (proxyResponse) => {
            response.writeHead(
                proxyResponse.statusCode ?? 502,
                proxyResponse.statusMessage,
                filterResponseHeaders(proxyResponse.headers),
            );
            proxyResponse.pipe(response);
        });

        proxyRequest.on('error', (error) => {
            console.error('Local client HTTP proxy failed:', error.message);
            writeError(response, 502, 'Bad Gateway');
        });
        request.on('aborted', () => proxyRequest.destroy());
        response.on('close', () => {
            if (!response.writableEnded) proxyRequest.destroy();
        });
        request.pipe(proxyRequest);
    });

    server.on('upgrade', (request, socket, head) => {
        const headers = filterRequestHeaders(request.headers, true);
        headers.authorization = authorization;
        const proxyRequest = makeRequest(target, {
            headers,
            method: request.method,
            path: request.url,
        });

        proxyRequest.on('upgrade', (proxyResponse, proxySocket, proxyHead) => {
            socket.write(
                `HTTP/1.1 ${proxyResponse.statusCode} ${proxyResponse.statusMessage}\r\n` +
                serializeHeaders(proxyResponse.rawHeaders) +
                '\r\n',
            );
            if (proxyHead.length) socket.write(proxyHead);
            if (head.length) proxySocket.write(head);
            proxySocket.pipe(socket);
            socket.pipe(proxySocket);
        });
        proxyRequest.on('response', (proxyResponse) => {
            socket.write(
                `HTTP/1.1 ${proxyResponse.statusCode} ${proxyResponse.statusMessage}\r\n` +
                serializeHeaders(proxyResponse.rawHeaders) +
                '\r\n',
            );
            proxyResponse.pipe(socket);
        });
        proxyRequest.on('error', (error) => {
            console.error('Local client WebSocket proxy failed:', error.message);
            writeSocketError(socket, 502, 'Bad Gateway');
        });
        socket.on('close', () => proxyRequest.destroy());
        proxyRequest.end(head);
    });

    return server;
}

function startClient() {
    const server = createClientServer({
        serverUrl: process.env.MMOPROXY_SERVER_URL,
        token: process.env.MMOPROXY_TOKEN,
    });
    server.on('error', (error) => {
        console.error('Unable to start local proxy:', error.message);
        process.exitCode = 1;
    });
    server.listen(15432, '127.0.0.1', () => {
        console.log('Local proxy listening on http://127.0.0.1:15432');
    });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
    try {
        startClient();
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}

export { createClientServer, filterRequestHeaders, validateConfiguration };
