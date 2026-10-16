const allowedMethods = 'GET, HEAD, PUT, PATCH, POST, DELETE, OPTIONS';

function appendVaryOrigin(value) {
    const values = Array.isArray(value) ? value.join(', ') : value;
    if (values?.split(',').some((header) => header.trim().toLowerCase() === 'origin')) {
        return values;
    }
    return values ? `${values}, Origin` : 'Origin';
}

function createCorsHeaders(request, existingHeaders = {}) {
    const headers = {
        'access-control-allow-credentials': 'true',
        vary: appendVaryOrigin(existingHeaders.vary ?? existingHeaders.Vary),
    };
    const origin = request.headers.origin;
    if (origin) headers['access-control-allow-origin'] = origin;

    if (request.method === 'OPTIONS' && request.headers['access-control-request-method']) {
        headers['access-control-allow-methods'] = allowedMethods;
        headers['access-control-max-age'] = '600';
        const requestedHeaders = request.headers['access-control-request-headers'];
        if (requestedHeaders) headers['access-control-allow-headers'] = requestedHeaders;
    }

    return headers;
}

function setCorsHeaders(request, response) {
    for (const [name, value] of Object.entries(createCorsHeaders(request, response.getHeaders()))) {
        response.setHeader(name, value);
    }
}

function isCorsPreflightRequest(request) {
    return request.method === 'OPTIONS' && Boolean(request.headers['access-control-request-method']);
}

export { createCorsHeaders, isCorsPreflightRequest, setCorsHeaders };
