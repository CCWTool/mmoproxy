import httpProxy from 'http-proxy';
import { getRandomPoolCookie, NumberPoolError } from './number-pool.js';

const hopByHopHeaders = new Set([
    'connection',
    'host',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'proxy-connection',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
    'authorization',
    'cookie',
]);

function readProxyHeaders(value) {
    if (!value) return {};

    let headers;
    try {
        headers = JSON.parse(value);
    } catch (error) {
        throw new Error('WS_PROXY_HEADERS must be a JSON object', { cause: error });
    }

    if (!headers || typeof headers !== 'object' || Array.isArray(headers)) {
        throw new Error('WS_PROXY_HEADERS must be a JSON object');
    }

    for (const [name, headerValue] of Object.entries(headers)) {
        if (!name || typeof headerValue !== 'string') {
            throw new Error('WS_PROXY_HEADERS must map header names to string values');
        }
        const normalizedName = name.toLowerCase();
        if (hopByHopHeaders.has(normalizedName) || normalizedName.startsWith('sec-websocket-')) {
            throw new Error(`WS_PROXY_HEADERS cannot override ${name}`);
        }
    }

    return headers;
}

function buildUpstreamHeaders(request, configuredHeaders, cookie) {
    const headers = {};
    const isWebSocket = request.headers.upgrade?.toLowerCase() === 'websocket';

    for (const [name, value] of Object.entries(request.headers)) {
        const normalizedName = name.toLowerCase();
        const isHandshakeHeader = isWebSocket
            && (normalizedName === 'connection'
                || normalizedName === 'upgrade'
                || normalizedName.startsWith('sec-websocket-'));
        if ((hopByHopHeaders.has(normalizedName) && !isHandshakeHeader)
            || (normalizedName.startsWith('sec-websocket-') && !isWebSocket)) {
            continue;
        }
        if (value !== undefined) headers[normalizedName] = value;
    }

    for (const [name, value] of Object.entries(configuredHeaders)) {
        const normalizedName = name.toLowerCase();
        if (hopByHopHeaders.has(normalizedName) || normalizedName.startsWith('sec-websocket-')) {
            throw new Error(`WS_PROXY_HEADERS cannot override ${name}`);
        }
        headers[normalizedName] = value;
    }
    headers.cookie = cookie;
    return headers;
}

function writeHttpError(socket, status, message) {
    if (socket.destroyed) return;
    const body = `${message}\n`;
    socket.end(
        `HTTP/1.1 ${status} ${message}\r\n` +
        'Connection: close\r\n' +
        'Content-Type: text/plain; charset=utf-8\r\n' +
        `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    );
}

function getStatusForError(error) {
    return error instanceof NumberPoolError ? 503 : 500;
}

function writeHttpResponse(response, status, message) {
    if (response.destroyed) return;
    if (response.headersSent) {
        response.destroy();
        return;
    }
    const body = `${message}\n`;
    response.writeHead(status, {
        'Connection': 'close',
        'Content-Length': Buffer.byteLength(body),
        'Content-Type': 'text/plain; charset=utf-8',
    });
    response.end(body);
}

function attachProxy(server, database, {
    host = process.env.WS_PROXY_HOST || '0.0.0.0',
    port = Number(process.env.WS_PROXY_PORT || 9989),
    upstreamUrl = process.env.WS_UPSTREAM_URL || 'wss://ws.example.com',
    httpUpstreamUrl = process.env.HTTP_UPSTREAM_URL
        || (upstreamUrl.startsWith('wss:') ? upstreamUrl.replace(/^wss:/, 'https:') : ''),
    configuredHeaders = readProxyHeaders(process.env.WS_PROXY_HEADERS),
} = {}) {
    const target = new URL(upstreamUrl);
    if (target.protocol !== 'wss:') {
        throw new Error('WS_UPSTREAM_URL must use the wss:// protocol');
    }
    const httpTarget = new URL(httpUpstreamUrl);
    if (httpTarget.protocol !== 'http:' && httpTarget.protocol !== 'https:') {
        throw new Error('HTTP_UPSTREAM_URL must use the http:// or https:// protocol');
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('WS_PROXY_PORT must be an integer between 1 and 65535');
    }

    const proxy = httpProxy.createProxyServer();
    const requestStates = new WeakMap();

    async function refundCharge(state, description) {
        if (!state || state.refunded || !state.charged) return;
        state.refunded = true;
        try {
            if (!await database.refundUserMinute(state.userId)) {
                console.error(`Unable to refund ${description} for user ${state.userId}`);
            }
        } catch (error) {
            console.error(`Unable to refund ${description}:`, error.message);
        }
    }

    proxy.on('error', (error, request, response) => {
        console.error('Proxy request failed:', error.message);
        const state = requestStates.get(request);
        if (state?.kind === 'websocket') {
            if (state.upgraded) {
                response?.destroy?.(error);
                return;
            }
            void refundCharge(state, 'initial WebSocket charge');
            writeHttpError(response, 502, 'Bad Gateway');
        } else if (response && typeof response.writeHead === 'function') {
            void refundCharge(state, 'HTTP request charge');
            writeHttpResponse(response, 502, 'Bad Gateway');
        } else {
            response?.destroy?.(error);
        }
    });

    async function handleHttpRequest(request, response) {
        const bearer = request.headers.authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];
        if (!bearer) {
            writeHttpResponse(response, 401, 'Unauthorized');
            return;
        }

        let userId;
        try {
            userId = await database.validateBearerToken(bearer);
        } catch (error) {
            console.error('Unable to validate HTTP proxy token:', error.message);
            writeHttpResponse(response, 500, 'Internal Server Error');
            return;
        }
        if (userId === null || userId === undefined) {
            writeHttpResponse(response, 401, 'Unauthorized');
            return;
        }

        try {
            if (!await database.chargeUserMinute(userId)) {
                writeHttpResponse(response, 402, 'Payment Required');
                return;
            }
        } catch (error) {
            console.error('Unable to charge for HTTP proxy request:', error.message);
            writeHttpResponse(response, 503, 'Service Unavailable');
            return;
        }

        const state = { charged: true, kind: 'http', refunded: false, userId };
        requestStates.set(request, state);

        try {
            const cookie = await getRandomPoolCookie(database);
            request.headers = buildUpstreamHeaders(request, configuredHeaders, cookie);
            proxy.web(request, response, {
                changeOrigin: true,
                target: httpTarget.origin,
            });
        } catch (error) {
            console.error('HTTP proxy request failed:', error.message);
            await refundCharge(state, 'HTTP request charge');
            const status = getStatusForError(error);
            writeHttpResponse(response, status, status === 503
                ? 'Service Unavailable'
                : 'Internal Server Error');
        }
    }

    server.on('request', (request, response) => {
        handleHttpRequest(request, response).catch((error) => {
            console.error('HTTP proxy request failed:', error.message);
            writeHttpResponse(response, 500, 'Internal Server Error');
        });
    });

    server.once('close', () => proxy.close());

    async function handleUpgrade(request, socket, head) {
        const bearer = request.headers.authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];
        if (!bearer) {
            writeHttpError(socket, 401, 'Unauthorized');
            return;
        }

        let userId;
        try {
            userId = await database.validateBearerToken(bearer);
        } catch (error) {
            console.error('Unable to validate WebSocket proxy token:', error.message);
            writeHttpError(socket, 500, 'Internal Server Error');
            return;
        }
        if (userId === null || userId === undefined) {
            writeHttpError(socket, 401, 'Unauthorized');
            return;
        }

        let charged;
        try {
            charged = await database.chargeUserMinute(userId);
        } catch (error) {
            console.error('Unable to charge for WebSocket connection:', error.message);
            writeHttpError(socket, 503, 'Service Unavailable');
            return;
        }
        if (!charged) {
            writeHttpError(socket, 402, 'Payment Required');
            return;
        }

        const state = {
            charged: true,
            kind: 'websocket',
            refunded: false,
            upgraded: false,
            userId,
        };
        requestStates.set(request, state);

        socket.once('close', () => {
            if (!state.upgraded) void refundCharge(state, 'initial WebSocket charge');
        });

        try {
            const cookie = await getRandomPoolCookie(database);
            request.headers = buildUpstreamHeaders(request, configuredHeaders, cookie);
            proxy.ws(request, socket, head, {
                changeOrigin: true,
                target: target.origin,
            });
        } catch (error) {
            await refundCharge(state, 'initial WebSocket charge');
            throw error;
        }
    }

    proxy.on('proxyReqWs', (proxyRequest, request, socket) => {
        const state = requestStates.get(request);
        if (!state) return;
        proxyRequest.once('upgrade', (_response, proxySocket) => {
            state.upgraded = true;
            startMinuteBilling(socket, proxySocket, state.userId, database);
        });
        proxyRequest.once('response', () => {
            void refundCharge(state, 'initial WebSocket charge');
        });
    });

    server.on('upgrade', (request, socket, head) => {
        handleUpgrade(request, socket, head).catch((error) => {
            console.error('WebSocket proxy request failed:', error.message);
            const status = getStatusForError(error);
            writeHttpError(socket, status, status === 503
                ? 'Service Unavailable'
                : 'Internal Server Error');
        });
    });

    return { host, port };
}

function startMinuteBilling(clientSocket, upstreamSocket, userId, database) {
    let timer;
    let stopped = false;
    const stop = () => {
        stopped = true;
        clearTimeout(timer);
    };
    clientSocket.once('close', stop);
    upstreamSocket.once('close', stop);

    const chargeNextMinute = async () => {
        if (stopped) return;
        try {
            const charged = await database.chargeUserMinute(userId);
            if (!charged) {
                clientSocket.destroy();
                upstreamSocket.destroy();
                return;
            }
            if (stopped) {
                if (!await database.refundUserMinute(userId)) {
                    console.error(`Unable to refund a WebSocket minute charge for user ${userId}`);
                }
                return;
            }
        } catch (error) {
            console.error('Unable to charge for active WebSocket connection:', error.message);
            clientSocket.destroy();
            upstreamSocket.destroy();
            return;
        }
        if (!stopped) timer = setTimeout(chargeNextMinute, 60_000);
    };

    timer = setTimeout(chargeNextMinute, 60_000);
}

export { attachProxy, buildUpstreamHeaders, readProxyHeaders };
