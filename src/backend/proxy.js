import httpProxy from 'http-proxy';
import { getRandomPoolCookie, NumberPoolError } from './number-pool.js';
import { createCorsHeaders, isCorsPreflightRequest, setCorsHeaders } from './cors.js';

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

function getProxyToken(request) {
    const bearer = request.headers.authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];
    if (bearer) return bearer;

    const requestUrl = new URL(request.url, 'http://localhost');
    const tokens = requestUrl.searchParams.getAll('token');
    return tokens.length === 1 && tokens[0] ? tokens[0] : null;
}

function removeTokenQueryParameter(request) {
    const queryIndex = request.url.indexOf('?');
    if (queryIndex === -1) return;

    const path = request.url.slice(0, queryIndex);
    const query = request.url.slice(queryIndex + 1);
    const forwardedParameters = query.split('&').filter((parameter) => {
        const name = new URLSearchParams(parameter).keys().next().value;
        return name !== 'token';
    });
    request.url = path + (forwardedParameters.length ? `?${forwardedParameters.join('&')}` : '');
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
    upstreamUrl = process.env.WS_UPSTREAM_URL,
    httpUpstreamUrl = process.env.HTTP_UPSTREAM_URL
        || (upstreamUrl?.startsWith('wss:') ? upstreamUrl.replace(/^wss:/, 'https:') : ''),
    configuredHeaders = readProxyHeaders(process.env.WS_PROXY_HEADERS),
} = {}) {
    if (!upstreamUrl) {
        throw new Error('WS_UPSTREAM_URL is required');
    }
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
        if (!state || state.refunded || (!state.charged && state.kind !== 'websocket')) return;
        state.refunded = true;
        try {
            const refunded = state.kind === 'http'
                ? await database.refundHttpsRequest(state.userId, state.charged)
                : await database.cancelWssUsage(state.userId, state.usage);
            if (!refunded) {
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

    proxy.on('proxyRes', (proxyResponse, request) => {
        Object.assign(proxyResponse.headers, createCorsHeaders(request, proxyResponse.headers));
    });

    async function handleHttpRequest(request, response) {
        setCorsHeaders(request, response);
        if (isCorsPreflightRequest(request)) {
            response.writeHead(204);
            response.end();
            return;
        }

        const token = getProxyToken(request);
        if (!token) {
            writeHttpResponse(response, 401, 'Unauthorized');
            return;
        }

        let userId;
        try {
            userId = await database.validateBearerToken(token);
        } catch (error) {
            console.error('Unable to validate HTTP proxy token:', error.message);
            writeHttpResponse(response, 500, 'Internal Server Error');
            return;
        }
        if (userId === null || userId === undefined) {
            writeHttpResponse(response, 401, 'Unauthorized');
            return;
        }

        let charge;
        try {
            charge = await database.chargeHttpsRequest(userId);
            if (!charge) {
                writeHttpResponse(response, 402, 'Payment Required');
                return;
            }
        } catch (error) {
            console.error('Unable to charge for HTTP proxy request:', error.message);
            writeHttpResponse(response, 503, 'Service Unavailable');
            return;
        }

        const state = { charged: charge, kind: 'http', refunded: false, userId };
        requestStates.set(request, state);

        try {
            const cookie = await getRandomPoolCookie(database);
            removeTokenQueryParameter(request);
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
        const token = getProxyToken(request);
        if (!token) {
            writeHttpError(socket, 401, 'Unauthorized');
            return;
        }

        let userId;
        try {
            userId = await database.validateBearerToken(token);
        } catch (error) {
            console.error('Unable to validate WebSocket proxy token:', error.message);
            writeHttpError(socket, 500, 'Internal Server Error');
            return;
        }
        if (userId === null || userId === undefined) {
            writeHttpError(socket, 401, 'Unauthorized');
            return;
        }

        let usage;
        try {
            usage = await database.beginWssUsage(userId);
        } catch (error) {
            console.error('Unable to initialize WebSocket billing:', error.message);
            writeHttpError(socket, 503, 'Service Unavailable');
            return;
        }
        if (!usage) {
            writeHttpError(socket, 402, 'Payment Required');
            return;
        }

        const state = {
            charged: false,
            kind: 'websocket',
            refunded: false,
            upgraded: false,
            usage,
            userId,
        };
        requestStates.set(request, state);
        socket.once('close', () => {
            if (!state.upgraded) void refundCharge(state, 'initial WebSocket reservation');
        });

        try {
            const cookie = await getRandomPoolCookie(database);
            removeTokenQueryParameter(request);
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
            startMinuteBilling(socket, proxySocket, state.userId, state.usage, database);
        });
        proxyRequest.once('response', () => {
            void refundCharge(state, 'initial WebSocket reservation');
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

function startMinuteBilling(clientSocket, upstreamSocket, userId, usage, database) {
    let timer;
    let stopped = false;
    let settled = false;
    const startedAt = Date.now();
    const stop = () => {
        stopped = true;
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        const durationSeconds = (Date.now() - startedAt) / 1000;
        database.settleWssUsage(userId, usage, durationSeconds).then((success) => {
            if (!success) console.error(`Unable to settle WebSocket billing for user ${userId}`);
        }).catch((error) => {
            console.error(`Unable to settle WebSocket billing for user ${userId}:`, error.message);
        });
    };
    clientSocket.once('close', stop);
    upstreamSocket.once('close', stop);

    const checkNextMinute = async () => {
        if (stopped) return;
        try {
            const elapsedSeconds = (Date.now() - startedAt) / 1000;
            if (!await database.canContinueWssUsage(userId, usage, elapsedSeconds + 1)) {
                clientSocket.destroy();
                upstreamSocket.destroy();
                return;
            }
        } catch (error) {
            console.error('Unable to check active WebSocket billing:', error.message);
            clientSocket.destroy();
            upstreamSocket.destroy();
            return;
        }
        if (!stopped) timer = setTimeout(checkNextMinute, 60_000);
    };

    timer = setTimeout(checkNextMinute, 60_000);
}

export { attachProxy, buildUpstreamHeaders, readProxyHeaders };
