import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const originalSqlitePath = process.env.SQLITE_PATH;
const directory = mkdtempSync(path.join(tmpdir(), 'mmoproxy-db-test-'));
process.env.SQLITE_PATH = path.join(directory, 'test.db');
const legacyDb = new Database(process.env.SQLITE_PATH);
legacyDb.exec(`
    CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL
    );
    CREATE TABLE user_api_keys (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        key_hash TEXT UNIQUE NOT NULL
    );
    INSERT INTO user_api_keys (user_id, key_hash) VALUES (1, 'legacy-api-key-hash');
    CREATE TABLE number_pool (
        uuid TEXT PRIMARY KEY NOT NULL,
        token TEXT,
        password TEXT
    );
`);
legacyDb.close();
const { default: db, knownPermissions } = await import('../../src/backend/db.js');
await db.ready;

const legacyDirectory = mkdtempSync(path.join(tmpdir(), 'mmoproxy-legacy-db-test-'));
const legacyPath = path.join(legacyDirectory, 'legacy.db');
const legacyFixture = new Database(legacyPath);
legacyFixture.exec(`
    CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL
    );
    INSERT INTO users (username, password) VALUES ('legacy-user', 'legacy-password');
`);
legacyFixture.close();
process.env.SQLITE_PATH = legacyPath;
const { default: migratedDb } = await import('../../src/backend/db.js?legacy-migration-test');
await migratedDb.ready;
assert.ok(db.db.pragma('table_info(user_api_keys)').some((column) => column.name === 'name'));
assert.equal(db.db.prepare('SELECT name FROM user_api_keys WHERE key_hash = ?')
    .get('legacy-api-key-hash').name, '');
process.env.SQLITE_PATH = path.join(directory, 'test.db');

after(() => {
    db.db.close();
    migratedDb.db.close();
    rmSync(directory, { recursive: true, force: true });
    rmSync(legacyDirectory, { recursive: true, force: true });
    if (originalSqlitePath === undefined) {
        delete process.env.SQLITE_PATH;
    } else {
        process.env.SQLITE_PATH = originalSqlitePath;
    }
});

test('creates an initial administrator with the requested permissions and a SHA-256 password', async () => {
    const admin = db.db.prepare('SELECT id, username, password, permissions FROM users WHERE username LIKE ?').get('admin-%');
    assert.ok(admin);
    assert.match(admin.password, /^[a-f0-9]{64}$/);
    assert.deepEqual(JSON.parse(admin.permissions).sort(), [
        'admin.config.rw',
        'admin.pool.edit',
        'admin.pool.read',
        'admin.users.edit',
        'admin.users.read',
        'user.login',
        'user.plan.read',
    ]);
});

test('hashes new user passwords, migrates legacy passwords, and manages user permissions', async () => {
    assert.ok(knownPermissions.includes('user.key'));
    assert.equal(await db.register('proxy-user', 'password'), true);
    const user = db.db.prepare('SELECT id, password FROM users WHERE username = ?').get('proxy-user');
    assert.equal(user.password, createHash('sha256').update('password').digest('hex'));
    assert.ok(await db.login('proxy-user', 'password'));
    assert.equal(await db.login('proxy-user', 'incorrect'), null);

    assert.equal(await migratedDb.db.prepare('SELECT password FROM users WHERE username = ?').get('legacy-user').password,
        createHash('sha256').update('legacy-password').digest('hex'));
    assert.ok(await migratedDb.login('legacy-user', 'legacy-password'));

    assert.deepEqual(await db.getUserById(user.id), {
        id: user.id,
        username: 'proxy-user',
        balanceFen: 0,
        data: {},
        permissions: ['user.login', 'user.plan.read'],
    });
    assert.equal(await db.updateUserPermissions(user.id, ['user.login', 'admin.pool.read']), true);
    assert.deepEqual((await db.getUserById(user.id)).permissions, ['user.login', 'admin.pool.read']);
});

test('credits payments and vouchers exactly once and charges active minutes atomically', async () => {
    const user = db.db.prepare('SELECT id FROM users WHERE username = ?').get('proxy-user');
    await db.createPaymentOrder(user.id, 550, 'payment-order-1');
    assert.equal(await db.completePaymentOrder('payment-order-1', 550, 'provider-trade-1'), true);
    assert.equal(await db.completePaymentOrder('payment-order-1', 550, 'provider-trade-1'), true);
    assert.equal((await db.getUserById(user.id)).balanceFen, 550);

    assert.equal(await db.chargeUserMinute(user.id), true);
    assert.equal((await db.getUserById(user.id)).balanceFen, 540);
    assert.equal(await db.chargeUserMinute(999_999), false);

    const code = await db.createVoucher(700);
    assert.match(code, /^[a-f0-9]{64}$/);
    assert.notEqual(
        db.db.prepare('SELECT code_hash FROM voucher_codes').get().code_hash,
        code,
    );
    assert.equal(await db.redeemVoucher(user.id, code), 700);
    assert.equal(await db.redeemVoucher(user.id, code), null);
    assert.equal((await db.getUserById(user.id)).balanceFen, 1240);
});

test('creates, rotates, lists, and removes owner-scoped API keys without storing plaintext secrets', async () => {
    const user = db.db.prepare('SELECT id FROM users WHERE username = ?').get('proxy-user');
    const otherUser = await db.createUser('other-user', 'password', ['user.login']);
    assert.equal(otherUser, true);
    const other = db.db.prepare('SELECT id FROM users WHERE username = ?').get('other-user');

    const created = await db.createUserApiKey(user.id, 'development laptop');
    assert.match(created.key, /^[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(await db.listUserApiKeys(user.id), [{ id: created.id, name: 'development laptop' }]);
    assert.deepEqual(await db.listUserApiKeys(other.id), []);
    assert.notEqual(
        db.db.prepare('SELECT key_hash FROM user_api_keys WHERE id = ?').get(created.id).key_hash,
        created.key,
    );
    assert.equal(await db.validateBearerToken(created.key), user.id);
    assert.equal(await db.renameUserApiKey(other.id, created.id, 'not yours'), false);
    assert.equal(await db.renameUserApiKey(user.id, created.id, 'personal workstation'), true);
    assert.equal(await db.renameUserApiKey(user.id, created.id, 'personal workstation'), true);
    assert.deepEqual(await db.listUserApiKeys(user.id), [{ id: created.id, name: 'personal workstation' }]);
    assert.equal(await db.rotateUserApiKey(other.id, created.id), null);
    assert.equal(await db.deleteUserApiKey(other.id, created.id), false);

    const rotatedKey = await db.rotateUserApiKey(user.id, created.id);
    assert.match(rotatedKey, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(rotatedKey, created.key);
    assert.equal(await db.validateBearerToken(created.key), null);
    assert.equal(await db.validateBearerToken(rotatedKey), user.id);

    assert.equal(await db.deleteUserApiKey(user.id, created.id), true);
    assert.equal(await db.validateBearerToken(rotatedKey), null);
    assert.deepEqual(await db.listUserApiKeys(user.id), []);
});

test('validates bearer keys against their associated user and reads number-pool entries', async () => {
    assert.ok(db.db.pragma('table_info(number_pool)').some((column) => column.name === 'cookie-user-id'));
    assert.ok(db.db.pragma('table_info(number_pool)').some((column) => column.name === 'token_valid'));
    assert.ok(db.db.pragma('table_info(number_pool)').some((column) => column.name === 'validation_info'));
    const user = db.db.prepare('SELECT id FROM users WHERE username = ?').get('proxy-user');
    db.db.prepare('INSERT INTO bearer_tokens (`key`, id) VALUES (?, ?)').run('proxy-key', user.id);
    db.db.prepare('INSERT INTO number_pool (uuid, token, password, `cookie-user-id`) VALUES (?, ?, ?, ?)').run(
        'pool-account-1',
        'cookie-token',
        null,
        'pool-student-oid',
    );

    assert.equal(await db.validateBearerToken('proxy-key'), user.id);
    assert.equal(await db.validateBearerToken('unknown-key'), null);
    assert.deepEqual(await db.getRandomNumberPoolEntry(), {
        uuid: 'pool-account-1',
        token: 'cookie-token',
        password: null,
        cookieUserId: 'pool-student-oid',
    });
    assert.equal(await db.updateNumberPoolToken('pool-account-1', 'refreshed-token', 'refreshed-oid'), true);
    assert.equal((await db.getRandomNumberPoolEntry()).token, 'refreshed-token');
    assert.equal((await db.getRandomNumberPoolEntry()).cookieUserId, 'refreshed-oid');
});

test('lists pool accounts without secrets and resets cached credentials when changing passwords', async () => {
    await db.createNumberPoolAccount('managed-account', 'initial-pool-password');
    db.db.prepare('UPDATE number_pool SET token = ?, `cookie-user-id` = ? WHERE uuid = ?')
        .run('cached-token', 'cached-user', 'managed-account');
    assert.deepEqual(await db.getNumberPoolAccount('managed-account'), {
        uuid: 'managed-account',
        token: 'cached-token',
        password: 'initial-pool-password',
        cookieUserId: 'cached-user',
    });
    assert.equal(await db.getNumberPoolAccount('missing-account'), null);
    assert.deepEqual(await db.listNumberPoolAccounts(), [
        { uuid: 'managed-account', cookieUserId: 'cached-user', hasPassword: true, valid: null, info: '' },
        { uuid: 'pool-account-1', cookieUserId: 'refreshed-oid', hasPassword: false, valid: null, info: '' },
    ]);

    await db.updateNumberPoolValidation('managed-account', false, '密码错误');
    await db.createNumberPoolAccount('token-only-account', null, 'token-only');
    assert.deepEqual(await db.listNumberPoolAccounts(), [
        { uuid: 'managed-account', cookieUserId: 'cached-user', hasPassword: true, valid: false, info: '密码错误' },
        { uuid: 'pool-account-1', cookieUserId: 'refreshed-oid', hasPassword: false, valid: null, info: '' },
        { uuid: 'token-only-account', cookieUserId: null, hasPassword: false, valid: null, info: '' },
    ]);

    assert.equal(await db.updateNumberPoolPassword('managed-account', 'updated-pool-password'), true);
    assert.deepEqual(db.db.prepare('SELECT password, token, `cookie-user-id` AS cookieUserId, token_valid AS valid, validation_info AS info FROM number_pool WHERE uuid = ?')
        .get('managed-account'), {
        password: 'updated-pool-password',
        token: null,
        cookieUserId: null,
        valid: null,
        info: '',
    });
    assert.equal(await db.deleteNumberPoolAccount('managed-account'), true);
    assert.equal(await db.deleteNumberPoolAccount('managed-account'), false);
    assert.deepEqual((await db.listNumberPoolAccounts()).map((account) => account.uuid), [
        'pool-account-1',
        'token-only-account',
    ]);
});
