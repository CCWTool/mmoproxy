const cookieValuePattern = /^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]+$/;
const cookieCache = new Map();
const cookieCacheTtlMilliseconds = 30 * 60 * 1000;
const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';
const loginUrl = 'https://sso.ccw.site/web/auth/login-by-password';
const studentDetailUrl = 'https://community-web.ccw.site/students/self/detail';
const studentDetailRequestBody = JSON.stringify({
    needGrade: true,
    needExtraInfo: true,
    fields: [
        'gender',
        'school',
        'qq',
        'host',
        'bio',
        'province',
        'city',
        'addressCode',
        'accountNumber',
        'createdAt',
        'updatedAt',
        'parents',
    ],
});

class NumberPoolError extends Error {
    constructor(message, code, options) {
        super(message, options);
        this.name = 'NumberPoolError';
        this.code = code;
    }
}

async function fetchStudentDetails(token, cookieUserId) {
    if (!cookieValuePattern.test(String(token)) || !cookieValuePattern.test(String(cookieUserId))) {
        throw new NumberPoolError('Student detail Cookie values contain invalid characters', 'INVALID_COOKIE_VALUE');
    }

    const response = await fetch(studentDetailUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Cookie: `token=${token}; cookie-user-id=${cookieUserId}`,
            'User-Agent': userAgent,
        },
        body: studentDetailRequestBody,
    });

    if (response.status !== 200) {
        throw new NumberPoolError(
            `Failed to fetch student details: ${response.statusText || response.status}`,
            'PROFILE_FAILED',
        );
    }

    let result;
    try {
        result = await response.json();
    } catch (error) {
        throw new NumberPoolError('Failed to parse student details response', 'PROFILE_FAILED', { cause: error });
    }

    const profile = result?.body;
    const oid = profile?.oid;
    if ((typeof oid !== 'string' && typeof oid !== 'number')
        || !cookieValuePattern.test(String(oid))) {
        throw new NumberPoolError('Student details response did not contain a valid account OID', 'PROFILE_FAILED');
    }
    return {
        name: typeof profile.name === 'string' ? profile.name : null,
        cookieUserId: String(oid),
    };
}

async function loginWithDetails(uuid, password, force = false) {
    if (typeof uuid !== 'string' || !uuid || typeof password !== 'string' || !password) {
        throw new NumberPoolError('Account UUID and password are required', 'INVALID_ACCOUNT');
    }

    const cacheKey = `${uuid}:${password}`;
    const cached = cookieCache.get(cacheKey);
    if (!force && cached) {
        if (cached.expiresAt > Date.now()) {
            return cached;
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

    const details = await fetchStudentDetails(token, uuid);
    const cookie = `token=${token}; cookie-user-id=${details.cookieUserId}`;
    cookieCache.set(cacheKey, {
        cookie,
        ...details,
        expiresAt: Date.now() + cookieCacheTtlMilliseconds,
    });
    return cookieCache.get(cacheKey);
}

async function login(uuid, password, force = false) {
    return (await loginWithDetails(uuid, password, force)).cookie;
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
    let refreshedName = null;

    try {
        if (typeof account.token === 'string' && account.token.length > 0
            && cookieValuePattern.test(account.token)) {
            try {
                const details = await fetchStudentDetails(account.token, account.cookieUserId || account.uuid);
                isValid = true;
                refreshedCookieUserId = details.cookieUserId;
                refreshedName = details.name;
            } catch (error) {
                if (!account.password) info = error.message;
            }
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
            refreshedToken = tokenFromSetCookie(setCookieHeaders);
            if (refreshedToken) {
                const details = await fetchStudentDetails(refreshedToken, account.cookieUserId || account.uuid);
                isValid = true;
                refreshedCookieUserId = details.cookieUserId;
                refreshedName = details.name;
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
    if (refreshedName !== null || refreshedCookieUserId !== account.cookieUserId) {
        await database.updateNumberPoolProfile(account.uuid, refreshedName, refreshedCookieUserId);
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
        const loginDetails = await loginWithDetails(account.uuid, account.password, true);
        const { token, cookieUserId } = parseAccountCookie(loginDetails.cookie);
        if (!token || !cookieUserId || !cookieValuePattern.test(token)) {
            throw new NumberPoolError('Number-pool login returned invalid Cookie values', 'LOGIN_FAILED');
        }
        if (!await database.updateNumberPoolToken(account.uuid, token, cookieUserId)) {
            throw new NumberPoolError('Number-pool account no longer exists', 'ACCOUNT_NOT_FOUND');
        }
        await database.updateNumberPoolProfile(account.uuid, loginDetails.name, cookieUserId);
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
        const loginDetails = await loginWithDetails(account.uuid, account.password);
        const cookie = loginDetails.cookie;
        ({ token, cookieUserId } = parseAccountCookie(cookie));
        if (!token || !cookieUserId) {
            throw new NumberPoolError('Number-pool login returned an invalid Cookie', 'LOGIN_FAILED');
        }
        if (!await database.updateNumberPoolToken(account.uuid, token, cookieUserId)) {
            throw new NumberPoolError('Number-pool account no longer exists', 'ACCOUNT_NOT_FOUND');
        }
        await database.updateNumberPoolProfile(account.uuid, loginDetails.name, cookieUserId);
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
