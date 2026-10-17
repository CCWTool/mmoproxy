import { envPath, reloadEnvironment } from './config.js';
import express from 'express';
import { createServer } from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { chmod, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import db, { knownPermissions } from './db.js';
import { deleteUserSession, validateUserSession } from './session.js';
import {
    canChangeUserPassword,
    canChangeUserPermissions,
    canDelegateUserPermissions,
} from './permission-delegation.js';
import { attachProxy } from './proxy.js';
import { isCorsPreflightRequest, setCorsHeaders } from './cors.js';
import {
    createPaymentUrl,
    getPaymentTypes,
    newOrderNumber,
    verifyEpayCallback,
    yuanToFen,
} from './payment.js';
import {
    loginNumberPoolAccount,
    NumberPoolError,
    removeNumberPoolAccount,
    validateNumberPoolAccount,
    validateNumberPoolAccounts,
} from './number-pool.js';

const app = express();
const port = Number(process.env.PORT) || 3000;
const frontendDir = path.resolve('dist/frontend');
const clientPath = path.resolve('dist/client.js');
const sessionCookieName = 'session';

app.disable('x-powered-by');
app.use((request, response, next) => {
    setCorsHeaders(request, response);
    if (isCorsPreflightRequest(request)) return response.status(204).end();
    return next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.get('/api/health', (_request, response) => {
    response.json({ status: 'ok' });
});

function getSessionId(request) {
    const cookies = request.headers.cookie?.split(';') ?? [];
    const sessionCookie = cookies.find((cookie) => cookie.trim().startsWith(`${sessionCookieName}=`));
    return sessionCookie?.trim().slice(sessionCookieName.length + 1) || null;
}

app.get('/api/auth/session', async (request, response) => {
    try {
        const sessionId = getSessionId(request);
        const userId = sessionId ? await validateUserSession(sessionId) : null;
        const user = userId ? await db.getUserById(userId) : null;
        const authenticated = user
            && Array.isArray(user.permissions) && user.permissions.includes('user.login');
        response.set('Cache-Control', 'no-store');
        return response.json({ authenticated: Boolean(authenticated), user: authenticated ? user : null });
    } catch (error) {
        console.error('Error validating user session:', error);
        return response.status(500).json({ message: 'Unable to check login status' });
    }
});

async function getAuthenticatedUser(request) {
    const sessionId = getSessionId(request);
    const userId = sessionId ? await validateUserSession(sessionId) : null;
    const user = userId ? await db.getUserById(userId) : null;
    return user && Array.isArray(user.permissions) && user.permissions.includes('user.login') ? user : null;
}

async function requirePermissions(request, response, permissions, matchAll = false) {
    const user = await getAuthenticatedUser(request);
    if (!user) {
        response.status(401).json({ message: '请先登录。' });
        return null;
    }
    const hasPermissions = matchAll
        ? permissions.every((permission) => user.permissions.includes(permission))
        : permissions.some((permission) => user.permissions.includes(permission));
    if (!hasPermissions) {
        response.status(403).json({ message: '你没有执行此操作的权限。' });
        return null;
    }
    return user;
}

function validatePassword(password) {
    return typeof password === 'string' && password.length > 0 && password.length <= 1024;
}

function validateApiKeyName(name) {
    return typeof name === 'string' && name.trim().length > 0 && name.trim().length <= 64;
}

function validateQuota(value) {
    return Number.isSafeInteger(value) && value >= -1;
}

function validateFen(value) {
    return Number.isSafeInteger(value) && value >= 0;
}

app.get('/api/touser', async (_request, response) => {
    try {
        const documentation = await readFile(path.resolve(process.cwd(), 'TOUSER.md'), 'utf8');
        response.set('Cache-Control', 'no-cache');
        return response.type('text/markdown').send(documentation);
    } catch (error) {
        console.error('Error reading TOUSER.md:', error);
        return response.status(500).json({ message: '无法读取 TOUSER.md。' });
    }
});

app.get('/api/admin/users', async (request, response) => {
    try {
        if (!await requirePermissions(request, response, ['admin.users.read'])) return;
        return response.json({ users: await db.listUsers() });
    } catch (error) {
        console.error('Error listing users:', error);
        return response.status(500).json({ message: '无法读取用户列表。' });
    }
});

app.get('/api/user/profile', async (request, response) => {
    try {
        const user = await getAuthenticatedUser(request);
        if (!user) return response.status(401).json({ message: '请先登录。' });
        response.set('Cache-Control', 'no-store');
        return response.json({
            username: user.username,
            balanceFen: user.balanceFen,
            planId: user.planId,
            planName: user.planName,
            planType: user.planType,
            planExpiresAt: user.planExpiresAt,
            paymentTypes: getPaymentTypes(),
        });
    } catch (error) {
        console.error('Error reading user profile:', error);
        return response.status(500).json({ message: '无法读取个人中心信息。' });
    }
});

app.get('/api/admin/plans', async (request, response) => {
    try {
        const user = await requirePermissions(request, response, [
            'admin.plan',
            'admin.users.plan',
            'user.plan.read',
        ]);
        if (!user) return;
        response.set('Cache-Control', 'no-store');
        return response.json({
            plans: await db.listPlans(),
            rates: await db.getBillingRates(),
            currentPlanId: user.planId,
            currentPlanName: user.planName,
            currentPlanExpiresAt: user.planExpiresAt,
        });
    } catch (error) {
        console.error('Error listing plans:', error);
        return response.status(500).json({ message: '无法读取套餐列表。' });
    }
});

app.post('/api/user/plans/:id/purchase', async (request, response) => {
    try {
        const user = await requirePermissions(request, response, ['user.plan.read']);
        if (!user) return;
        const planId = Number(request.params.id);
        if (!Number.isSafeInteger(planId) || planId < 1) {
            return response.status(400).json({ message: '套餐编号无效。' });
        }
        const purchased = await db.purchasePlan(user.id, planId);
        if (!purchased) return response.status(400).json({ message: '套餐不存在、余额不足或账户已封禁。' });
        return response.json({ success: true });
    } catch (error) {
        console.error('Error purchasing plan:', error);
        return response.status(500).json({ message: '无法购买套餐。' });
    }
});

app.post('/api/user/recharge', async (request, response) => {
    try {
        const user = await getAuthenticatedUser(request);
        if (!user) return response.status(401).json({ message: '请先登录。' });
        const amountFen = yuanToFen(request.body?.amount);
        if (!amountFen || amountFen < 100 || amountFen > 100_000_000) {
            return response.status(400).json({ message: '充值金额须为 1.00 至 1,000,000.00 元，最多两位小数。' });
        }
        const paymentType = request.body?.paymentType;
        if (typeof paymentType !== 'string' || !getPaymentTypes().includes(paymentType)) {
            return response.status(400).json({ message: '请选择有效的支付方式。' });
        }
        const orderNo = newOrderNumber();
        const baseUrl = `${request.protocol}://${request.get('host')}`;
        const paymentUrl = createPaymentUrl({ amountFen, orderNo, baseUrl, paymentType });
        await db.createPaymentOrder(user.id, amountFen, orderNo);
        response.set('Cache-Control', 'no-store');
        return response.status(201).json({ paymentUrl });
    } catch (error) {
        console.error('Error creating payment order:', error);
        return response.status(503).json({ message: error.message || '无法创建充值订单。' });
    }
});

app.post('/api/payments/epay/notify', async (request, response) => {
    try {
        const params = request.body ?? {};
        const { EPAY_PID: pid, EPAY_KEY: key } = process.env;
        const amountFen = yuanToFen(params.money);
        if (!pid || !key || params.pid !== pid || !verifyEpayCallback(params, key)
            || params.trade_status !== 'TRADE_SUCCESS' || !params.out_trade_no
            || !amountFen || typeof params.trade_no !== 'string') {
            return response.status(400).type('text/plain').send('fail');
        }
        const completed = await db.completePaymentOrder(
            params.out_trade_no,
            amountFen,
            params.trade_no,
        );
        if (!completed) return response.status(400).type('text/plain').send('fail');
        return response.type('text/plain').send('success');
    } catch (error) {
        console.error('Error processing payment notification:', error);
        return response.status(500).type('text/plain').send('fail');
    }
});

app.post('/api/user/vouchers/redeem', async (request, response) => {
    try {
        const user = await getAuthenticatedUser(request);
        if (!user) return response.status(401).json({ message: '请先登录。' });
        const code = request.body?.code;
        if (typeof code !== 'string' || !/^[a-f\d]{64}$/i.test(code)) {
            return response.status(400).json({ message: '兑换码必须为 256 位十六进制字符串。' });
        }
        const amountFen = await db.redeemVoucher(user.id, code.toLowerCase());
        if (amountFen === null) return response.status(400).json({ message: '兑换码无效或已使用。' });
        response.set('Cache-Control', 'no-store');
        return response.json({ success: true, amountFen });
    } catch (error) {
        console.error('Error redeeming voucher:', error);
        return response.status(500).json({ message: '兑换码兑换失败。' });
    }
});

app.get('/api/admin/config', async (request, response) => {
    try {
        if (!await requirePermissions(request, response, ['admin.config.rw'])) return;
        let content = '';
        try {
            content = await readFile(envPath, 'utf8');
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
        response.set('Cache-Control', 'no-store');
        return response.json({ content });
    } catch (error) {
        console.error('Error reading application configuration:', error);
        return response.status(500).json({ message: '无法读取 .env 配置文件。' });
    }
});

app.put('/api/admin/config', async (request, response) => {
    try {
        if (!await requirePermissions(request, response, ['admin.config.rw'])) return;
        const { content } = request.body ?? {};
        if (typeof content !== 'string' || content.length > 65_536 || content.includes('\0')) {
            return response.status(400).json({ message: '.env 内容无效或超过 64 KiB。' });
        }

        const temporaryPath = `${envPath}.${randomUUID()}.tmp`;
        try {
            await writeFile(temporaryPath, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
            await chmod(temporaryPath, 0o600);
            await rename(temporaryPath, envPath);
        } catch (error) {
            await unlink(temporaryPath).catch((cleanupError) => {
                if (cleanupError.code !== 'ENOENT') throw cleanupError;
            });
            throw error;
        }
        reloadEnvironment(content);
        return response.json({ success: true });
    } catch (error) {
        console.error('Error updating application configuration:', error);
        return response.status(500).json({ message: '无法保存 .env 配置文件。' });
    }
});

app.post('/api/admin/vouchers', async (request, response) => {
    try {
        if (!await requirePermissions(request, response, ['admin.config.rw'])) return;
        const amountFen = yuanToFen(request.body?.amount);
        if (!amountFen || amountFen > 100_000_000) {
            return response.status(400).json({ message: '兑换码金额须大于 0 且不超过 1,000,000.00 元。' });
        }
        const code = await db.createVoucher(amountFen);
        response.set('Cache-Control', 'no-store');
        return response.status(201).json({ code, amountFen });
    } catch (error) {
        console.error('Error creating voucher:', error);
        return response.status(500).json({ message: '无法生成兑换码。' });
    }
});

app.post('/api/admin/users', async (request, response) => {
    try {
        const actor = await requirePermissions(request, response, ['admin.users.permissions']);
        if (!actor) return;
        const { username, password, permissions } = request.body ?? {};
        if (typeof username !== 'string' || !username.trim() || username.trim().length > 64
            || !validatePassword(password) || !Array.isArray(permissions)
            || permissions.some((permission) => typeof permission !== 'string' || !knownPermissions.includes(permission))) {
            return response.status(400).json({ message: '请提供有效的用户名、密码和权限列表。' });
        }
        if (!canDelegateUserPermissions(actor, null, permissions)) {
            return response.status(403).json({ message: '只能授予自己已有的权限，且不能授予 admin.users.permissions。' });
        }
        const success = await db.createUser(
            username.trim(),
            password,
            [...new Set(['user.login', ...permissions])],
        );
        if (!success) return response.status(409).json({ message: '用户名已存在。' });
        return response.status(201).json({ success: true });
    } catch (error) {
        console.error('Error creating user:', error);
        return response.status(500).json({ message: '无法创建用户。' });
    }
});

app.put('/api/admin/users/:id', async (request, response) => {
    try {
        const actor = await getAuthenticatedUser(request);
        if (!actor) return response.status(401).json({ message: '请先登录。' });
        const id = Number(request.params.id);
        const input = request.body ?? {};
        const allowedFields = new Set(['permissions', 'password', 'isBanned', 'planId', 'balanceFen', 'balanceDeltaFen']);
        if (!Number.isSafeInteger(id) || id < 1
            || !input || typeof input !== 'object' || Array.isArray(input)
            || !Object.keys(input).length
            || Object.keys(input).some((key) => !allowedFields.has(key))) {
            return response.status(400).json({ message: '请提供有效的用户编号和修改内容。' });
        }

        const permissionRequirements = {
            permissions: 'admin.users.permissions',
            password: 'admin.users.edit',
            isBanned: 'admin.users.ban',
            planId: 'admin.users.plan',
            balanceFen: 'admin.users.balance',
            balanceDeltaFen: 'admin.users.balance',
        };
        if (Object.keys(input).some((key) => !actor.permissions.includes(permissionRequirements[key]))) {
            return response.status(403).json({ message: '你没有修改这些用户信息的权限。' });
        }
        if (Object.hasOwn(input, 'permissions')
            && (!Array.isArray(input.permissions)
                || input.permissions.some((permission) => typeof permission !== 'string'
                    || !knownPermissions.includes(permission)))) {
            return response.status(400).json({ message: '权限列表无效。' });
        }
        if (Object.hasOwn(input, 'permissions')
            && !canDelegateUserPermissions(actor, id, input.permissions)) {
            return response.status(403).json({ message: '只能修改其他用户，且只能授予自己已有的权限（不能授予 admin.users.permissions）。' });
        }
        if (Object.hasOwn(input, 'password') && !validatePassword(input.password)) {
            return response.status(400).json({ message: '密码无效。' });
        }
        let target;
        if (Object.hasOwn(input, 'permissions') || Object.hasOwn(input, 'password')) {
            target = await db.getUserById(id);
            if (!target) return response.status(404).json({ message: '用户不存在。' });
        }
        if (Object.hasOwn(input, 'permissions') && !canChangeUserPermissions(actor, id, target)) {
            return response.status(403).json({ message: '只能修改权限严格少于自己的用户的权限。' });
        }
        if (Object.hasOwn(input, 'password') && !canChangeUserPassword(actor, target)) {
            return response.status(403).json({ message: '只能修改权限严格少于自己的用户密码。' });
        }
        if (Object.hasOwn(input, 'isBanned') && typeof input.isBanned !== 'boolean') {
            return response.status(400).json({ message: '封禁状态无效。' });
        }
        if (Object.hasOwn(input, 'planId') && input.planId !== null
            && (!Number.isSafeInteger(input.planId) || input.planId < 1)) {
            return response.status(400).json({ message: '套餐编号无效。' });
        }
        if (Object.hasOwn(input, 'balanceFen') && !validateFen(input.balanceFen)) {
            return response.status(400).json({ message: '余额金额无效。' });
        }
        if (Object.hasOwn(input, 'balanceDeltaFen') && !validateFen(input.balanceDeltaFen)) {
            return response.status(400).json({ message: '余额增加金额无效。' });
        }
        if (Object.hasOwn(input, 'balanceFen') && Object.hasOwn(input, 'balanceDeltaFen')
            && !Number.isSafeInteger(input.balanceFen + input.balanceDeltaFen)) {
            return response.status(400).json({ message: '余额总额超出有效范围。' });
        }
        const changes = { ...input };
        if (changes.permissions) changes.permissions = [...new Set(changes.permissions)];
        const updated = await db.updateAdminUser(id, changes);
        if (updated === null) return response.status(404).json({ message: '套餐不存在。' });
        if (!updated) return response.status(404).json({ message: '用户不存在或没有可保存的更改。' });
        return response.json({ success: true });
    } catch (error) {
        console.error('Error updating user:', error);
        return response.status(500).json({ message: '无法更新用户信息。' });
    }
});

app.put('/api/admin/users/:id/permissions', async (request, response) => {
    try {
        const actor = await requirePermissions(request, response, ['admin.users.permissions']);
        if (!actor) return;
        const id = Number(request.params.id);
        const { permissions } = request.body ?? {};
        if (!Number.isSafeInteger(id) || id < 1 || !Array.isArray(permissions)
            || permissions.some((permission) => typeof permission !== 'string' || !knownPermissions.includes(permission))) {
            return response.status(400).json({ message: '请提供有效的用户编号和权限列表。' });
        }
        if (!canDelegateUserPermissions(actor, id, permissions)) {
            return response.status(403).json({ message: '只能修改其他用户，且只能授予自己已有的权限（不能授予 admin.users.permissions）。' });
        }
        const target = await db.getUserById(id);
        if (!target) return response.status(404).json({ message: '用户不存在。' });
        if (!canChangeUserPermissions(actor, id, target)) {
            return response.status(403).json({ message: '只能修改权限严格少于自己的用户的权限。' });
        }
        const success = await db.updateAdminUser(id, { permissions: [...new Set(permissions)] });
        if (!success) return response.status(404).json({ message: '用户不存在或没有可保存的更改。' });
        return response.json({ success: true });
    } catch (error) {
        console.error('Error updating user permissions:', error);
        return response.status(500).json({ message: '无法更新用户权限。' });
    }
});

app.put('/api/admin/users/:id/password', async (request, response) => {
    try {
        const actor = await requirePermissions(request, response, ['admin.users.edit']);
        if (!actor) return;
        const id = Number(request.params.id);
        if (!Number.isSafeInteger(id) || id < 1 || !validatePassword(request.body?.password)) {
            return response.status(400).json({ message: '请提供有效的用户编号和密码。' });
        }
        const target = await db.getUserById(id);
        if (!target) return response.status(404).json({ message: '用户不存在。' });
        if (!canChangeUserPassword(actor, target)) {
            return response.status(403).json({ message: '只能修改权限严格少于自己的用户密码。' });
        }
        const success = await db.updateUserPassword(id, request.body.password);
        if (!success) return response.status(404).json({ message: '用户不存在。' });
        return response.json({ success: true });
    } catch (error) {
        console.error('Error updating user password:', error);
        return response.status(500).json({ message: '无法更新用户密码。' });
    }
});

function parsePlanInput(body) {
    const {
        name,
        type,
        price,
        durationDays,
        httpsQuota,
        wssDurationMinutes,
        httpsOverage,
        wssOverage,
    } = body ?? {};
    const priceFen = yuanToFen(price);
    const httpsOverageFen = type === 'subscription' ? yuanToFen(httpsOverage) : 0;
    const wssOverageFen = type === 'subscription' ? yuanToFen(wssOverage) : 0;
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 64
        || !['subscription', 'resource'].includes(type)
        || priceFen === null || !validateQuota(httpsQuota)
        || !validateQuota(wssDurationMinutes)
        || (wssDurationMinutes !== -1 && wssDurationMinutes > Math.floor(Number.MAX_SAFE_INTEGER / 60))
        || (type === 'subscription'
            && (!Number.isSafeInteger(durationDays) || durationDays < 1 || durationDays > 36500))
        || (type === 'subscription' && (httpsOverageFen === null || wssOverageFen === null))) {
        return null;
    }
    return {
        name: name.trim(),
        type,
        priceFen,
        durationSeconds: type === 'subscription' ? durationDays * 86400 : 0,
        httpsQuota,
        wssConnectionQuota: -1,
        wssDurationSeconds: wssDurationMinutes === -1 ? -1 : wssDurationMinutes * 60,
        httpsOverageFen,
        wssOverageFen,
    };
}

app.post('/api/admin/plans', async (request, response) => {
    try {
        if (!await requirePermissions(request, response, ['admin.plan'])) return;
        const plan = parsePlanInput(request.body);
        if (!plan) return response.status(400).json({ message: '套餐设置无效，请检查名称、价格、类型和额度。' });
        const id = await db.savePlan({ ...plan, id: null });
        return response.status(201).json({ success: true, id });
    } catch (error) {
        console.error('Error creating plan:', error);
        return response.status(500).json({ message: '无法创建套餐。' });
    }
});

app.put('/api/admin/plans/:id', async (request, response) => {
    try {
        if (!await requirePermissions(request, response, ['admin.plan'])) return;
        const id = Number(request.params.id);
        const plan = parsePlanInput(request.body);
        if (!Number.isSafeInteger(id) || id < 1 || !plan) {
            return response.status(400).json({ message: '套餐编号或设置无效。' });
        }
        const updated = await db.savePlan({ ...plan, id });
        if (updated === null) return response.status(404).json({ message: '套餐不存在。' });
        return response.json({ success: true });
    } catch (error) {
        console.error('Error updating plan:', error);
        return response.status(500).json({ message: '无法更新套餐。' });
    }
});

app.delete('/api/admin/plans/:id', async (request, response) => {
    try {
        if (!await requirePermissions(request, response, ['admin.plan'])) return;
        const id = Number(request.params.id);
        if (!Number.isSafeInteger(id) || id < 1) {
            return response.status(400).json({ message: '套餐编号无效。' });
        }
        if (!await db.deletePlan(id)) return response.status(404).json({ message: '套餐不存在。' });
        return response.json({ success: true });
    } catch (error) {
        console.error('Error deleting plan:', error);
        return response.status(500).json({ message: '无法移除套餐。' });
    }
});

app.put('/api/admin/billing-rates', async (request, response) => {
    try {
        if (!await requirePermissions(request, response, ['admin.plan'])) return;
        const httpsPriceFen = yuanToFen(request.body?.httpsPrice);
        const wssPriceFen = yuanToFen(request.body?.wssPrice);
        if (httpsPriceFen === null || wssPriceFen === null) {
            return response.status(400).json({ message: '默认计费价格无效。' });
        }
        await db.updateBillingRates(httpsPriceFen, wssPriceFen);
        return response.json({ success: true });
    } catch (error) {
        console.error('Error updating default billing rates:', error);
        return response.status(500).json({ message: '无法保存默认计费价格。' });
    }
});

app.get('/api/user/keys', async (request, response) => {
    try {
        const user = await requirePermissions(request, response, ['user.key']);
        if (!user) return;
        response.set('Cache-Control', 'no-store');
        return response.json({ keys: await db.listUserApiKeys(user.id) });
    } catch (error) {
        console.error('Error listing user API keys:', error);
        return response.status(500).json({ message: '无法读取密钥列表。' });
    }
});

app.post('/api/user/keys', async (request, response) => {
    try {
        const user = await requirePermissions(request, response, ['user.key']);
        if (!user) return;
        const { name } = request.body ?? {};
        if (!validateApiKeyName(name)) {
            return response.status(400).json({ message: '密钥名称不能为空且不能超过 64 个字符。' });
        }
        const apiKey = await db.createUserApiKey(user.id, name.trim());
        response.set('Cache-Control', 'no-store');
        return response.status(201).json({ apiKey });
    } catch (error) {
        console.error('Error creating user API key:', error);
        return response.status(500).json({ message: '无法创建密钥。' });
    }
});

app.put('/api/user/keys/:id', async (request, response) => {
    try {
        const user = await requirePermissions(request, response, ['user.key']);
        if (!user) return;
        const id = Number(request.params.id);
        const { name } = request.body ?? {};
        if (!Number.isSafeInteger(id) || id < 1 || !validateApiKeyName(name)) {
            return response.status(400).json({ message: '请提供有效的密钥编号和名称（1 至 64 个字符）。' });
        }
        const updated = await db.renameUserApiKey(user.id, id, name.trim());
        if (!updated) return response.status(404).json({ message: '密钥不存在。' });
        return response.json({ success: true });
    } catch (error) {
        console.error('Error renaming user API key:', error);
        return response.status(500).json({ message: '无法重命名密钥。' });
    }
});

app.post('/api/user/keys/:id/rotate', async (request, response) => {
    try {
        const user = await requirePermissions(request, response, ['user.key']);
        if (!user) return;
        const id = Number(request.params.id);
        if (!Number.isSafeInteger(id) || id < 1) {
            return response.status(400).json({ message: '密钥编号无效。' });
        }
        const key = await db.rotateUserApiKey(user.id, id);
        if (!key) return response.status(404).json({ message: '密钥不存在。' });
        response.set('Cache-Control', 'no-store');
        return response.json({ apiKey: { id, key } });
    } catch (error) {
        console.error('Error rotating user API key:', error);
        return response.status(500).json({ message: '无法轮换密钥。' });
    }
});

app.delete('/api/user/keys/:id', async (request, response) => {
    try {
        const user = await requirePermissions(request, response, ['user.key']);
        if (!user) return;
        const id = Number(request.params.id);
        if (!Number.isSafeInteger(id) || id < 1) {
            return response.status(400).json({ message: '密钥编号无效。' });
        }
        const deleted = await db.deleteUserApiKey(user.id, id);
        if (!deleted) return response.status(404).json({ message: '密钥不存在。' });
        return response.json({ success: true });
    } catch (error) {
        console.error('Error deleting user API key:', error);
        return response.status(500).json({ message: '无法移除密钥。' });
    }
});

app.get('/api/admin/pool', async (request, response) => {
    try {
        if (!await requirePermissions(request, response, ['admin.pool.read', 'admin.pool.edit'])) return;
        return response.json({ accounts: await db.listNumberPoolAccounts() });
    } catch (error) {
        console.error('Error listing number-pool accounts:', error);
        return response.status(500).json({ message: '无法读取号池账号。' });
    }
});

app.post('/api/admin/pool', async (request, response) => {
    try {
        if (!await requirePermissions(request, response, ['admin.pool.edit'])) return;
        const { uuid, password, token } = request.body ?? {};
        const hasPassword = validatePassword(password);
        const hasToken = typeof token === 'string' && token.length > 0 && token.length <= 4096;
        if (typeof uuid !== 'string' || !uuid.trim() || uuid.trim().length > 255
            || hasPassword === hasToken) {
            return response.status(400).json({ message: '请提供有效的账号 UUID，以及密码或 token。' });
        }
        try {
            await db.createNumberPoolAccount(uuid.trim(), hasPassword ? password : null, hasToken ? token : null);
        } catch (error) {
            if (error.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || error.code === 'ER_DUP_ENTRY') {
                return response.status(409).json({ message: '该号池账号已存在。' });
            }
            throw error;
        }
        await validateNumberPoolAccount({
            uuid: uuid.trim(),
            password: hasPassword ? password : null,
            token: hasToken ? token : null,
            cookieUserId: null,
        }, db);
        return response.status(201).json({ success: true });
    } catch (error) {
        console.error('Error creating number-pool account:', error);
        return response.status(500).json({ message: '无法创建号池账号。' });
    }
});

app.delete('/api/admin/pool/:uuid', async (request, response) => {
    try {
        if (!await requirePermissions(request, response, ['admin.pool.edit'])) return;
        const success = await removeNumberPoolAccount(request.params.uuid, db);
        if (!success) return response.status(404).json({ message: '号池账号不存在。' });
        return response.json({ success: true });
    } catch (error) {
        console.error('Error deleting number-pool account:', error);
        return response.status(500).json({ message: '无法移除号池账号。' });
    }
});

app.post('/api/admin/pool/:uuid/login', async (request, response) => {
    try {
        if (!await requirePermissions(request, response, ['admin.pool.edit'])) return;
        const account = await db.getNumberPoolAccount(request.params.uuid);
        if (!account) return response.status(404).json({ message: '号池账号不存在。' });
        if (!account.password) return response.status(400).json({ message: '该账号没有保存密码，无法立即登录。' });
        await loginNumberPoolAccount(account, db);
        return response.json({ success: true });
    } catch (error) {
        if (error instanceof NumberPoolError && error.code === 'ACCOUNT_NOT_FOUND') {
            return response.status(404).json({ message: '号池账号不存在。' });
        }
        console.error('Error logging in to number-pool account:', error);
        return response.status(502).json({ message: `号池账号登录失败：${error.message}` });
    }
});

app.put('/api/admin/pool/:uuid/password', async (request, response) => {
    try {
        if (!await requirePermissions(request, response, ['admin.pool.edit'])) return;
        const { uuid } = request.params;
        if (!uuid || !validatePassword(request.body?.password)) {
            return response.status(400).json({ message: '请提供有效的账号 UUID 和密码。' });
        }
        const success = await db.updateNumberPoolPassword(uuid, request.body.password);
        if (!success) return response.status(404).json({ message: '号池账号不存在。' });
        return response.json({ success: true });
    } catch (error) {
        console.error('Error updating number-pool password:', error);
        return response.status(500).json({ message: '无法更新号池账号密码。' });
    }
});

app.post('/api/web/login', async (request, response) => {
    const { username, password } = request.body ?? {};

    if (typeof username !== 'string' || typeof password !== 'string' || !username.trim() || !password) {
        return response.status(400).json({ message: '请输入用户名和密码。' });
    }

    try {
        const user = await db.login(username.trim(), password);

        if (!user) {
            return response.status(401).json({ message: '用户名或密码不正确。' });
        }

        response.set('Cache-Control', 'no-store');
        response.cookie(sessionCookieName, user.sessionId, {
            httpOnly: true,
            secure: request.secure || request.get('x-forwarded-proto') === 'https',
            sameSite: 'lax',
            path: '/',
            maxAge: 24 * 60 * 60 * 1000,
        });
        return response.json({ success: true });
    } catch (error) {
        console.error('Error during login:', error);
        return response.status(500).json({ message: '登录服务暂时不可用，请稍后重试。' });
    }
});

app.post('/api/web/logout', async (request, response) => {
    try {
        const sessionId = getSessionId(request);
        if (sessionId) await deleteUserSession(sessionId);
        response.clearCookie(sessionCookieName, { httpOnly: true, sameSite: 'lax', path: '/' });
        response.set('Cache-Control', 'no-store');
        return response.json({ success: true });
    } catch (error) {
        console.error('Error during logout:', error);
        return response.status(500).json({ message: 'Unable to log out' });
    }
});
app.post('/api/web/register', async (request, response) => {
    const { username, password } = request.body ?? {};

    if (typeof username !== 'string' || typeof password !== 'string' || !username.trim() || !password) {
        return response.status(400).json({ message: '请输入用户名和密码。' });
    }

    try {
        const success = await db.register(username.trim(), password);

        if (!success) {
            return response.status(409).json({ message: '用户名已存在，请选择其他用户名。' });
        }

        return response.json({ success: true });
    } catch (error) {
        console.error('Error during registration:', error);
        return response.status(500).json({ message: '注册服务暂时不可用，请稍后重试。' });
    }
});

app.get('/client.js', (_request, response, next) => {
    response.sendFile(clientPath, (error) => {
        if (error) next(error);
    });
});

app.use(express.static(frontendDir));
app.get(/.*/, (_request, response) => {
    response.sendFile(path.join(frontendDir, 'index.html'));
});

db.ready.then(async () => {
    await validateNumberPoolAccounts(db);
    const httpServer = createServer(app);
    const websocketServer = createServer();
    const websocketProxy = attachProxy(websocketServer, db);

    httpServer.listen(port, () => {
        console.log(`mmoproxy server listening on http://localhost:${port}`);
    });
    websocketServer.listen(websocketProxy.port, websocketProxy.host, () => {
        console.log(`HTTP/WebSocket proxy listening on http://${websocketProxy.host}:${websocketProxy.port} (ws://${websocketProxy.host}:${websocketProxy.port})`);
    });
}).catch((error) => {
    console.error('Failed to initialize the database:', error);
    process.exitCode = 1;
});