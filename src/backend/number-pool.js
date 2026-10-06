const cookieValuePattern = /^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]+$/;
const cookieCache = new Map();
const cookieCacheTtlMilliseconds = 30 * 60 * 1000;
const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';
const loginUrl = 'https://sso.ccw.site/web/auth/login-by-password';

class NumberPoolError extends Error {
    constructor(message, code, options) {
        super(message, options);
        this.name = 'NumberPoolError';
        this.code = code;
    }
}

async function fetchStudentOid(uuid) {
    const profileResponse = await fetch('https://community-web.ccw.site/students/profile', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ studentNumber: uuid }),
    });

    if (!profileResponse.ok) {
        throw new NumberPoolError(`Failed to fetch profile: ${profileResponse.statusText}`, 'PROFILE_FAILED');
    }

    let profile;
    try {
        profile = await profileResponse.json();
    } catch (error) {
        throw new NumberPoolError('Failed to parse student profile response', 'PROFILE_FAILED', { cause: error });
    }

    const cookieUserId = profile.body?.studentOid;
    if (typeof cookieUserId !== 'string' && typeof cookieUserId !== 'number') {
        throw new NumberPoolError('Failed to get student OID', 'PROFILE_FAILED');
    }
    return cookieUserId;
}

async function login(uuid, password, force = false) {
    if (typeof uuid !== 'string' || !uuid || typeof password !== 'string' || !password) {
        throw new NumberPoolError('Account UUID and password are required', 'INVALID_ACCOUNT');
    }

    const cacheKey = `${uuid}:${password}`;
    const cached = cookieCache.get(cacheKey);
    if (!force && cached) {
        if (cached.expiresAt > Date.now()) {
            return cached.cookie;
        }
        cookieCache.delete(cacheKey);
    }

    const loginResponse = await fetch(loginUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'User-Agent': userAgent,
        },
        body: JSON.stringify({
            loginKey: uuid,
            clientCode: 'STUDY_COMMUNITY',
            password,
            extra: '{"device":"Windows 10","browser":"Chrome 146","scene":null}',
        }),
    });

    if (!loginResponse.ok) {
        throw new NumberPoolError(`CCW login failed: ${loginResponse.statusText}`, 'LOGIN_FAILED');
    }

    const setCookieHeaders = typeof loginResponse.headers.getSetCookie === 'function'
        ? loginResponse.headers.getSetCookie()
        : [loginResponse.headers.get('set-cookie')].filter(Boolean);
    let token = null;

    for (const cookieString of setCookieHeaders) {
        const match = cookieString.match(/(?:^|,\s*)token=([^;,]*)/i);
        if (match) {
            token = match[1];
            break;
        }
    }

    if (!token) {
        throw new NumberPoolError('CCW login failed: no token cookie found', 'LOGIN_FAILED');
    }

    const cookieUserId = await fetchStudentOid(uuid);

    const cookie = `token=${token}; cookie-user-id=${cookieUserId}`;
    cookieCache.set(cacheKey, {
        cookie,
        expiresAt: Date.now() + cookieCacheTtlMilliseconds,
    });
    return cookie;
}

function getSetCookieHeaders(response) {
    return typeof response.headers.getSetCookie === 'function'
        ? response.headers.getSetCookie()
        : [response.headers.get('set-cookie')].filter(Boolean);
}

function tokenFromSetCookie(headers) {
    for (const cookieString of headers) {
        const match = cookieString.match(/(?:^|,\s*)token=([^;,]*)/i);
        if (match) return match[1];
    }
    return null;
}

async function getLoginMessage(response) {
    try {
        const result = await response.json();
        const message = result?.msg;
        return typeof message === 'string' ? message : message == null ? '' : JSON.stringify(message);
    } catch (error) {
        console.error('Failed to parse CCW login response:', error);
        return '无法解析登录响应体 JSON。';
    }
}

async function validateNumberPoolAccount(account, database) {
    let isValid = false;
    let info = '';
    let refreshedToken = null;
    let refreshedCookieUserId = account.cookieUserId;

    try {
        if (typeof account.token === 'string' && account.token.length > 0
            && cookieValuePattern.test(account.token)) {
            const response = await fetch('https://community-web.ccw.site/students/self/detail', {
                headers: {
                    Cookie: `token=${account.token}; cookie-user-id=${account.cookieUserId || account.uuid}`,
                    'User-Agent': userAgent,
                },
            });
            isValid = response.status === 200;
        }

        if (!isValid && account.password) {
            const loginResponse = await fetch(loginUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': userAgent,
                },
                body: JSON.stringify({
                    loginKey: account.uuid,
                    clientCode: 'STUDY_COMMUNITY',
                    password: account.password,
                    extra: '{"device":"Windows 10","browser":"Chrome 146","scene":null}',
                }),
            });
            const setCookieHeaders = getSetCookieHeaders(loginResponse);
            isValid = setCookieHeaders.length > 0;
            if (isValid) {
                refreshedToken = tokenFromSetCookie(setCookieHeaders);
                if (refreshedToken) {
                    try {
                        refreshedCookieUserId = await fetchStudentOid(account.uuid);
                    } catch (error) {
                        console.error(`Failed to refresh student OID for number-pool account ${account.uuid}:`, error);
                    }
                }
            } else {
                info = await getLoginMessage(loginResponse);
            }
        }
    } catch (error) {
        console.error(`Failed to validate number-pool account ${account.uuid}:`, error);
        info = error.message;
    }

    if (!isValid && !account.password && !info) {
        info = '仅 token 账号无法自动重新登录。';
    }

    if (refreshedToken) {
        await database.updateNumberPoolToken(account.uuid, refreshedToken, refreshedCookieUserId);
    }
    await database.updateNumberPoolValidation(account.uuid, isValid, info);
    return { valid: isValid, info };
}

async function validateNumberPoolAccounts(database) {
    const accounts = await database.getNumberPoolAccounts();
    for (const account of accounts) {
        try {
            await validateNumberPoolAccount(account, database);
        } catch (error) {
            console.error(`Failed to validate number-pool account ${account.uuid}:`, error);
            await database.updateNumberPoolValidation(account.uuid, false, error.message);
        }
    }
}

async function loginWithAccount(account) {
    if (!account?.password) {
        throw new NumberPoolError('Account password not available', 'INVALID_ACCOUNT');
    }
    return login(account.uuid, account.password);
}

async function loginNumberPoolAccount(account, database) {
    if (!account?.password) {
        throw new NumberPoolError('Account password not available', 'INVALID_ACCOUNT');
    }

    try {
        const cookie = await login(account.uuid, account.password, true);
        const { token, cookieUserId } = parseAccountCookie(cookie);
        if (!token || !cookieUserId
            || !cookieValuePattern.test(token)
            || !cookieValuePattern.test(String(cookieUserId))) {
            throw new NumberPoolError('Number-pool login returned invalid Cookie values', 'LOGIN_FAILED');
        }
        if (!await database.updateNumberPoolToken(account.uuid, token, cookieUserId)) {
            throw new NumberPoolError('Number-pool account no longer exists', 'ACCOUNT_NOT_FOUND');
        }
        await database.updateNumberPoolValidation(account.uuid, true, '');
        return { token, cookieUserId };
    } catch (error) {
        await database.updateNumberPoolValidation(account.uuid, false, error.message);
        throw error;
    }
}

function parseAccountCookie(cookie) {
    const token = cookie.match(/(?:^|;\s*)token=([^;]*)/i)?.[1];
    const cookieUserId = cookie.match(/(?:^|;\s*)cookie-user-id=([^;]*)/i)?.[1];
    return { token, cookieUserId };
}

async function removeNumberPoolAccount(uuid, database) {
    const removed = await database.deleteNumberPoolAccount(uuid);
    if (removed) {
        const cachePrefix = `${uuid}:`;
        for (const cacheKey of cookieCache.keys()) {
            if (cacheKey.startsWith(cachePrefix)) cookieCache.delete(cacheKey);
        }
    }
    return removed;
}

async function getRandomPoolCookie(database) {
    const account = await database.getRandomNumberPoolEntry();
    if (!account) {
        throw new NumberPoolError('The number pool is empty', 'NUMBER_POOL_EMPTY');
    }

    let token = account.token;
    let cookieUserId = account.cookieUserId || account.uuid;
    if (typeof token !== 'string' || token.length === 0) {
        const cookie = await loginWithAccount(account);
        ({ token, cookieUserId } = parseAccountCookie(cookie));
        if (!token || !cookieUserId) {
            throw new NumberPoolError('Number-pool login returned an invalid Cookie', 'LOGIN_FAILED');
        }
        if (!await database.updateNumberPoolToken(account.uuid, token, cookieUserId)) {
            throw new NumberPoolError('Number-pool account no longer exists', 'ACCOUNT_NOT_FOUND');
        }
    }

    if (!cookieValuePattern.test(token) || !cookieValuePattern.test(String(cookieUserId))) {
        throw new NumberPoolError('Number-pool cookie values contain invalid characters', 'INVALID_COOKIE_VALUE');
    }

    return `token=${token}; cookie-user-id=${cookieUserId}`;
}

export {
    getRandomPoolCookie,
    login,
    loginWithAccount,
    loginNumberPoolAccount,
    NumberPoolError,
    removeNumberPoolAccount,
    validateNumberPoolAccount,
    validateNumberPoolAccounts,
};
