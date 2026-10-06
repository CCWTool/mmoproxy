import Database from 'better-sqlite3';
import { createPool } from 'mysql2/promise';
import { createHash, randomBytes } from 'node:crypto';
import { createUserSession } from './session.js';
import { hashVoucher, newVoucherCode } from './payment.js';

const adminPermissions = [
    'admin.users.read',
    'admin.users.edit',
    'admin.pool.read',
    'admin.pool.edit',
    'admin.config.rw',
];
const defaultPermissions = ['user.login', 'user.plan.read'];
const knownPermissions = [...defaultPermissions, 'user.key', ...adminPermissions];
const planPriceFenPerMinute = 10;

function hashPassword(password) {
    return createHash('sha256').update(password, 'utf8').digest('hex');
}

function parseJson(value, fallback) {
    if (typeof value !== 'string') return value ?? fallback;
    try {
        return JSON.parse(value);
    } catch (error) {
        throw new Error('Invalid JSON stored in the database', { cause: error });
    }
}

function getDatabaseConfig() {
    const databaseUrl = process.env.DATABASE_URL;
    const requestedType = process.env.DB_TYPE?.toLowerCase();
    const type = requestedType ?? (databaseUrl?.startsWith('mysql://') ? 'mysql' : 'sqlite');

    if (type !== 'sqlite' && type !== 'mysql') {
        throw new Error(`Unsupported database type: ${type}`);
    }

    if (type === 'sqlite') {
        return { type, path: process.env.SQLITE_PATH || 'user.db' };
    }

    if (databaseUrl) {
        const url = new URL(databaseUrl);
        if (url.protocol !== 'mysql:') {
            throw new Error('DATABASE_URL must use the mysql:// protocol');
        }

        const database = decodeURIComponent(url.pathname.slice(1));
        if (!url.hostname || !database) {
            throw new Error('DATABASE_URL must include a host and database name');
        }

        return {
            type,
            options: {
                host: url.hostname,
                port: Number(url.port) || 3306,
                user: decodeURIComponent(url.username),
                password: decodeURIComponent(url.password),
                database,
            },
        };
    }

    const database = process.env.DB_NAME;
    const user = process.env.DB_USER;
    if (!database || !user) {
        throw new Error('MySQL requires DATABASE_URL or both DB_NAME and DB_USER');
    }

    const port = Number(process.env.DB_PORT || 3306);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('DB_PORT must be an integer between 1 and 65535');
    }

    return {
        type,
        options: {
            host: process.env.DB_HOST || 'localhost',
            port,
            user,
            password: process.env.DB_PASSWORD || '',
            database,
        },
    };
}

class UserDatabase {
    constructor() {
        this.config = getDatabaseConfig();
        this.db = this.config.type === 'sqlite'
            ? new Database(this.config.path)
            : createPool(this.config.options);
        this.ready = this.init();
    }

    async init() {
        if (this.config.type === 'sqlite') {
            this.db.pragma('foreign_keys = ON');
            this.db.exec(`
                CREATE TABLE IF NOT EXISTS users (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    username TEXT UNIQUE NOT NULL,
                    password TEXT NOT NULL,
                    data JSON NOT NULL DEFAULT '{}',
                    permissions JSON NOT NULL DEFAULT '["user.login","user.plan.read"]',
                    balance_fen INTEGER NOT NULL DEFAULT 0
                )
            `);
            const userColumns = this.db.pragma('table_info(users)');
            if (!userColumns.some((column) => column.name === 'data')) {
                this.db.exec(`ALTER TABLE users ADD COLUMN data JSON NOT NULL DEFAULT '{}'`);
            }
            if (!userColumns.some((column) => column.name === 'permissions')) {
                this.db.exec(`ALTER TABLE users ADD COLUMN permissions JSON NOT NULL DEFAULT '["user.login"]'`);
            }
            if (!userColumns.some((column) => column.name === 'balance_fen')) {
                this.db.exec('ALTER TABLE users ADD COLUMN balance_fen INTEGER NOT NULL DEFAULT 0');
            }
            this.db.exec(`
                CREATE TABLE IF NOT EXISTS app_settings (
                    key TEXT PRIMARY KEY NOT NULL,
                    value TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS bearer_tokens (
                    \`key\` TEXT PRIMARY KEY NOT NULL,
                    id INTEGER NOT NULL,
                    FOREIGN KEY (id) REFERENCES users(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS user_api_keys (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    name TEXT NOT NULL DEFAULT '',
                    key_hash TEXT UNIQUE NOT NULL,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS number_pool (
                    uuid TEXT PRIMARY KEY NOT NULL,
                    token TEXT,
                    password TEXT,
                    \`cookie-user-id\` TEXT,
                    token_valid INTEGER,
                    validation_info TEXT NOT NULL DEFAULT ''
                );

                CREATE TABLE IF NOT EXISTS payment_orders (
                    order_no TEXT PRIMARY KEY NOT NULL,
                    user_id INTEGER NOT NULL,
                    amount_fen INTEGER NOT NULL,
                    status TEXT NOT NULL DEFAULT 'pending',
                    provider_trade_no TEXT,
                    created_at INTEGER NOT NULL,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS voucher_codes (
                    code_hash TEXT PRIMARY KEY NOT NULL,
                    amount_fen INTEGER NOT NULL,
                    redeemed_by INTEGER,
                    redeemed_at INTEGER,
                    FOREIGN KEY (redeemed_by) REFERENCES users(id) ON DELETE SET NULL
                )
            `);
            const apiKeyColumns = this.db.pragma('table_info(user_api_keys)');
            if (!apiKeyColumns.some((column) => column.name === 'name')) {
                this.db.exec("ALTER TABLE user_api_keys ADD COLUMN name TEXT NOT NULL DEFAULT ''");
            }
            const poolColumns = this.db.pragma('table_info(number_pool)');
            if (!poolColumns.some((column) => column.name === 'cookie-user-id')) {
                this.db.exec('ALTER TABLE number_pool ADD COLUMN `cookie-user-id` TEXT');
            }
            if (!poolColumns.some((column) => column.name === 'token_valid')) {
                this.db.exec('ALTER TABLE number_pool ADD COLUMN token_valid INTEGER');
            }
            if (!poolColumns.some((column) => column.name === 'validation_info')) {
                this.db.exec("ALTER TABLE number_pool ADD COLUMN validation_info TEXT NOT NULL DEFAULT ''");
            }
            this.addPlanPermissionToExistingUsers();
            const passwordMigration = this.db.prepare(
                'SELECT value FROM app_settings WHERE key = ?',
            ).get('passwords_sha256');
            if (!passwordMigration) {
                const migratePasswords = this.db.transaction(() => {
                    const users = this.db.prepare('SELECT id, password FROM users').all();
                    const updatePassword = this.db.prepare('UPDATE users SET password = ? WHERE id = ?');
                    for (const user of users) updatePassword.run(hashPassword(user.password), user.id);
                    this.db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)').run('passwords_sha256', '1');
                });
                migratePasswords();
            }
            await this.ensureInitialAdmin();
            return;
        }

        await this.db.query(`
            CREATE TABLE IF NOT EXISTS users (
                id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                username VARCHAR(255) UNIQUE NOT NULL,
                password CHAR(64) NOT NULL,
                data JSON NOT NULL,
                permissions JSON NOT NULL,
                balance_fen BIGINT NOT NULL DEFAULT 0
            )
        `);
        const [userColumns] = await this.db.query('SHOW COLUMNS FROM users');
        if (!userColumns.some((column) => column.Field === 'data')) {
            await this.db.query('ALTER TABLE users ADD COLUMN data JSON NULL');
            await this.db.query(`UPDATE users SET data = JSON_OBJECT() WHERE data IS NULL`);
            await this.db.query('ALTER TABLE users MODIFY COLUMN data JSON NOT NULL');
        }
        if (!userColumns.some((column) => column.Field === 'permissions')) {
            await this.db.query('ALTER TABLE users ADD COLUMN permissions JSON NULL');
            await this.db.query(`UPDATE users SET permissions = JSON_ARRAY('user.login') WHERE permissions IS NULL`);
            await this.db.query('ALTER TABLE users MODIFY COLUMN permissions JSON NOT NULL');
        }
        if (!userColumns.some((column) => column.Field === 'balance_fen')) {
            await this.db.query('ALTER TABLE users ADD COLUMN balance_fen BIGINT NOT NULL DEFAULT 0');
        }
        await this.db.query(`
            CREATE TABLE IF NOT EXISTS app_settings (
                \`key\` VARCHAR(100) NOT NULL PRIMARY KEY,
                value TEXT NOT NULL
            )
        `);
        const [settings] = await this.db.execute('SELECT value FROM app_settings WHERE `key` = ?', ['passwords_sha256']);
        if (!settings.length) {
            const connection = await this.db.getConnection();
            try {
                await connection.beginTransaction();
                const [migration] = await connection.execute(
                    'SELECT value FROM app_settings WHERE `key` = ?',
                    ['passwords_sha256'],
                );
                if (!migration.length) {
                    const [users] = await connection.query('SELECT id, password FROM users');
                    for (const user of users) {
                        await connection.execute(
                            'UPDATE users SET password = ? WHERE id = ?',
                            [hashPassword(user.password), user.id],
                        );
                    }
                    await connection.execute(
                        'INSERT INTO app_settings (`key`, value) VALUES (?, ?)',
                        ['passwords_sha256', '1'],
                    );
                }
                await connection.commit();
            } catch (error) {
                await connection.rollback();
                throw error;
            } finally {
                connection.release();
            }
        }
        await this.db.query(`
            CREATE TABLE IF NOT EXISTS bearer_tokens (
                \`key\` VARCHAR(255) NOT NULL PRIMARY KEY,
                id INT UNSIGNED NOT NULL,
                CONSTRAINT fk_bearer_tokens_user
                    FOREIGN KEY (id) REFERENCES users(id) ON DELETE CASCADE
            )
        `);
        await this.db.query(`
            CREATE TABLE IF NOT EXISTS user_api_keys (
                id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                user_id INT UNSIGNED NOT NULL,
                name VARCHAR(64) NOT NULL DEFAULT '',
                key_hash CHAR(64) NOT NULL UNIQUE,
                CONSTRAINT fk_user_api_keys_user
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        `);
        const [apiKeyColumns] = await this.db.query('SHOW COLUMNS FROM user_api_keys');
        if (!apiKeyColumns.some((column) => column.Field === 'name')) {
            await this.db.query("ALTER TABLE user_api_keys ADD COLUMN name VARCHAR(64) NOT NULL DEFAULT ''");
        }
        await this.db.query(`
            CREATE TABLE IF NOT EXISTS number_pool (
                uuid CHAR(36) NOT NULL PRIMARY KEY,
                token TEXT NULL,
                password TEXT NULL,
                \`cookie-user-id\` VARCHAR(255) NULL,
                token_valid BOOLEAN NULL,
                validation_info TEXT NULL
            )
        `);
        await this.db.query(`
            CREATE TABLE IF NOT EXISTS payment_orders (
                order_no VARCHAR(64) NOT NULL PRIMARY KEY,
                user_id INT UNSIGNED NOT NULL,
                amount_fen BIGINT NOT NULL,
                status VARCHAR(20) NOT NULL DEFAULT 'pending',
                provider_trade_no VARCHAR(255) NULL,
                created_at BIGINT NOT NULL,
                CONSTRAINT fk_payment_orders_user
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        `);
        await this.db.query(`
            CREATE TABLE IF NOT EXISTS voucher_codes (
                code_hash CHAR(64) NOT NULL PRIMARY KEY,
                amount_fen BIGINT NOT NULL,
                redeemed_by INT UNSIGNED NULL,
                redeemed_at BIGINT NULL,
                CONSTRAINT fk_voucher_codes_user
                    FOREIGN KEY (redeemed_by) REFERENCES users(id) ON DELETE SET NULL
            )
        `);
        const [poolColumns] = await this.db.query('SHOW COLUMNS FROM number_pool');
        if (!poolColumns.some((column) => column.Field === 'cookie-user-id')) {
            await this.db.query('ALTER TABLE number_pool ADD COLUMN `cookie-user-id` VARCHAR(255) NULL');
        }
        if (!poolColumns.some((column) => column.Field === 'token_valid')) {
            await this.db.query('ALTER TABLE number_pool ADD COLUMN token_valid BOOLEAN NULL');
        }
        if (!poolColumns.some((column) => column.Field === 'validation_info')) {
            await this.db.query('ALTER TABLE number_pool ADD COLUMN validation_info TEXT NULL');
        }
        await this.addPlanPermissionToExistingUsers();
        await this.ensureInitialAdmin();
    }

    async addPlanPermissionToExistingUsers() {
        if (this.config.type === 'sqlite') {
            const users = this.db.prepare('SELECT id, permissions FROM users').all();
            const update = this.db.prepare('UPDATE users SET permissions = ? WHERE id = ?');
            for (const user of users) {
                const permissions = parseJson(user.permissions, []);
                if (!permissions.includes('user.plan.read')) {
                    update.run(JSON.stringify([...permissions, 'user.plan.read']), user.id);
                }
            }
            return;
        }

        const [users] = await this.db.query('SELECT id, permissions FROM users');
        for (const user of users) {
            const permissions = parseJson(user.permissions, []);
            if (!permissions.includes('user.plan.read')) {
                await this.db.execute(
                    'UPDATE users SET permissions = ? WHERE id = ?',
                    [JSON.stringify([...permissions, 'user.plan.read']), user.id],
                );
            }
        }
    }

    async ensureInitialAdmin() {
        const countQuery = 'SELECT COUNT(*) AS count FROM users';
        const count = this.config.type === 'sqlite'
            ? this.db.prepare(countQuery).get().count
            : (await this.db.query(countQuery))[0][0].count;
        if (Number(count) !== 0) return;

        const username = `admin-${randomBytes(5).toString('hex')}`;
        const password = randomBytes(18).toString('base64url');
        const permissions = [...defaultPermissions, ...adminPermissions];
        if (this.config.type === 'sqlite') {
            this.db.prepare(
                'INSERT INTO users (username, password, data, permissions) VALUES (?, ?, ?, ?)',
            ).run(username, hashPassword(password), '{}', JSON.stringify(permissions));
        } else {
            await this.db.execute(
                'INSERT INTO users (username, password, data, permissions) VALUES (?, ?, ?, ?)',
                [username, hashPassword(password), JSON.stringify({}), JSON.stringify(permissions)],
            );
        }
        console.log(`Initial administrator created: username=${username} password=${password}`);
    }

    async login(user, pass) {
        await this.ready;
        const query = 'SELECT id, username, permissions FROM users WHERE username = ? AND password = ?';
        const params = [user, hashPassword(pass)];
        const row = this.config.type === 'sqlite'
            ? this.db.prepare(query).get(...params)
            : (await this.db.execute(query, params))[0][0];
        if (!row || !parseJson(row.permissions, []).includes('user.login')) return null;
        const sessionId = await createUserSession(row.id);
        return { id: row.id, username: row.username, sessionId };
    }

    async register(user, pass) {
        await this.ready;
        const query = 'INSERT INTO users (username, password, data, permissions) VALUES (?, ?, ?, ?)';
        const params = [user, hashPassword(pass), JSON.stringify({}), JSON.stringify(defaultPermissions)];
        try {
            if (this.config.type === 'sqlite') {
                this.db.prepare(query).run(...params);
            } else {
                await this.db.execute(query, params);
            }
            return true;
        } catch (error) {
            if (error.code === 'SQLITE_CONSTRAINT_UNIQUE' || error.code === 'ER_DUP_ENTRY') {
                return false;
            }
            throw error;
        }
    }

    async getUserById(id) {
        await this.ready;
        const query = 'SELECT id, username, data, permissions, balance_fen AS balanceFen FROM users WHERE id = ?';
        const row = this.config.type === 'sqlite'
            ? this.db.prepare(query).get(id)
            : (await this.db.execute(query, [id]))[0][0];
        return row ? {
            ...row,
            balanceFen: Number(row.balanceFen ?? 0),
            data: parseJson(row.data, {}),
            permissions: parseJson(row.permissions, []),
        } : null;
    }

    async listUsers() {
        await this.ready;
        const query = 'SELECT id, username, data, permissions, balance_fen AS balanceFen FROM users ORDER BY id';
        const rows = this.config.type === 'sqlite'
            ? this.db.prepare(query).all()
            : (await this.db.query(query))[0];
        return rows.map((row) => ({
            ...row,
            balanceFen: Number(row.balanceFen ?? 0),
            data: parseJson(row.data, {}),
            permissions: parseJson(row.permissions, []),
        }));
    }

    async createUser(username, password, permissions) {
        await this.ready;
        const query = 'INSERT INTO users (username, password, data, permissions) VALUES (?, ?, ?, ?)';
        const params = [username, hashPassword(password), JSON.stringify({}), JSON.stringify(permissions)];
        try {
            if (this.config.type === 'sqlite') {
                this.db.prepare(query).run(...params);
            } else {
                await this.db.execute(query, params);
            }
            return true;
        } catch (error) {
            if (error.code === 'SQLITE_CONSTRAINT_UNIQUE' || error.code === 'ER_DUP_ENTRY') return false;
            throw error;
        }
    }

    async updateUserPermissions(id, permissions) {
        await this.ready;
        const query = 'UPDATE users SET permissions = ? WHERE id = ?';
        const params = [JSON.stringify(permissions), id];
        if (this.config.type === 'sqlite') {
            return this.db.prepare(query).run(...params).changes === 1;
        }
        return (await this.db.execute(query, params))[0].affectedRows === 1;
    }

    async updateUserPassword(id, password) {
        await this.ready;
        const query = 'UPDATE users SET password = ? WHERE id = ?';
        const params = [hashPassword(password), id];
        if (this.config.type === 'sqlite') {
            return this.db.prepare(query).run(...params).changes === 1;
        }
        return (await this.db.execute(query, params))[0].affectedRows === 1;
    }

    async createPaymentOrder(userId, amountFen, orderNo) {
        await this.ready;
        const query = 'INSERT INTO payment_orders (order_no, user_id, amount_fen, status, created_at) VALUES (?, ?, ?, ?, ?)';
        const params = [orderNo, userId, amountFen, 'pending', Date.now()];
        if (this.config.type === 'sqlite') {
            this.db.prepare(query).run(...params);
            return;
        }
        await this.db.execute(query, params);
    }

    async completePaymentOrder(orderNo, amountFen, providerTradeNo) {
        await this.ready;
        if (this.config.type === 'sqlite') {
            const complete = this.db.transaction(() => {
                const order = this.db.prepare('SELECT user_id, amount_fen, status FROM payment_orders WHERE order_no = ?')
                    .get(orderNo);
                if (!order || Number(order.amount_fen) !== amountFen) return false;
                if (order.status === 'paid') return true;
                const updated = this.db.prepare(
                    "UPDATE payment_orders SET status = 'paid', provider_trade_no = ? WHERE order_no = ? AND status = 'pending'",
                ).run(providerTradeNo, orderNo);
                if (updated.changes !== 1) return false;
                this.db.prepare('UPDATE users SET balance_fen = balance_fen + ? WHERE id = ?')
                    .run(amountFen, order.user_id);
                return true;
            });
            return complete();
        }

        const connection = await this.db.getConnection();
        try {
            await connection.beginTransaction();
            const [orders] = await connection.execute(
                'SELECT user_id, amount_fen, status FROM payment_orders WHERE order_no = ? FOR UPDATE',
                [orderNo],
            );
            const order = orders[0];
            if (!order || Number(order.amount_fen) !== amountFen) {
                await connection.rollback();
                return false;
            }
            if (order.status === 'paid') {
                await connection.commit();
                return true;
            }
            const [updated] = await connection.execute(
                "UPDATE payment_orders SET status = 'paid', provider_trade_no = ? WHERE order_no = ? AND status = 'pending'",
                [providerTradeNo, orderNo],
            );
            if (updated.affectedRows !== 1) {
                await connection.rollback();
                return false;
            }
            await connection.execute('UPDATE users SET balance_fen = balance_fen + ? WHERE id = ?', [
                amountFen,
                order.user_id,
            ]);
            await connection.commit();
            return true;
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    }

    async createVoucher(amountFen) {
        await this.ready;
        const code = newVoucherCode();
        const query = 'INSERT INTO voucher_codes (code_hash, amount_fen) VALUES (?, ?)';
        const params = [hashVoucher(code), amountFen];
        if (this.config.type === 'sqlite') {
            this.db.prepare(query).run(...params);
        } else {
            await this.db.execute(query, params);
        }
        return code;
    }

    async redeemVoucher(userId, code) {
        await this.ready;
        const codeHash = hashVoucher(code);
        const redeemedAt = Date.now();
        if (this.config.type === 'sqlite') {
            const redeem = this.db.transaction(() => {
                const voucher = this.db.prepare(
                    'SELECT amount_fen FROM voucher_codes WHERE code_hash = ? AND redeemed_by IS NULL AND redeemed_at IS NULL',
                ).get(codeHash);
                if (!voucher) return null;
                const update = this.db.prepare(
                    'UPDATE voucher_codes SET redeemed_by = ?, redeemed_at = ? WHERE code_hash = ? AND redeemed_by IS NULL AND redeemed_at IS NULL',
                ).run(userId, redeemedAt, codeHash);
                if (update.changes !== 1) return null;
                this.db.prepare('UPDATE users SET balance_fen = balance_fen + ? WHERE id = ?')
                    .run(voucher.amount_fen, userId);
                return Number(voucher.amount_fen);
            });
            return redeem();
        }

        const connection = await this.db.getConnection();
        try {
            await connection.beginTransaction();
            const [vouchers] = await connection.execute(
                'SELECT amount_fen FROM voucher_codes WHERE code_hash = ? AND redeemed_by IS NULL AND redeemed_at IS NULL FOR UPDATE',
                [codeHash],
            );
            const voucher = vouchers[0];
            if (!voucher) {
                await connection.rollback();
                return null;
            }
            await connection.execute(
                'UPDATE voucher_codes SET redeemed_by = ?, redeemed_at = ? WHERE code_hash = ? AND redeemed_by IS NULL AND redeemed_at IS NULL',
                [userId, redeemedAt, codeHash],
            );
            await connection.execute('UPDATE users SET balance_fen = balance_fen + ? WHERE id = ?', [
                voucher.amount_fen,
                userId,
            ]);
            await connection.commit();
            return Number(voucher.amount_fen);
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    }

    async chargeUserMinute(userId) {
        await this.ready;
        const query = 'UPDATE users SET balance_fen = balance_fen - ? WHERE id = ? AND balance_fen >= ?';
        const params = [planPriceFenPerMinute, userId, planPriceFenPerMinute];
        if (this.config.type === 'sqlite') {
            return this.db.prepare(query).run(...params).changes === 1;
        }
        return (await this.db.execute(query, params))[0].affectedRows === 1;
    }

    async refundUserMinute(userId) {
        await this.ready;
        const query = 'UPDATE users SET balance_fen = balance_fen + ? WHERE id = ?';
        if (this.config.type === 'sqlite') {
            return this.db.prepare(query).run(planPriceFenPerMinute, userId).changes === 1;
        }
        return (await this.db.execute(query, [planPriceFenPerMinute, userId]))[0].affectedRows === 1;
    }

    async listUserApiKeys(userId) {
        await this.ready;
        const query = 'SELECT id, name FROM user_api_keys WHERE user_id = ? ORDER BY id';
        const rows = this.config.type === 'sqlite'
            ? this.db.prepare(query).all(userId)
            : (await this.db.execute(query, [userId]))[0];
        return rows.map((row) => ({ id: Number(row.id), name: row.name }));
    }

    async createUserApiKey(userId, name) {
        await this.ready;
        const key = randomBytes(32).toString('base64url');
        const keyHash = hashPassword(key);
        const query = 'INSERT INTO user_api_keys (user_id, name, key_hash) VALUES (?, ?, ?)';
        if (this.config.type === 'sqlite') {
            const result = this.db.prepare(query).run(userId, name, keyHash);
            return { id: Number(result.lastInsertRowid), name, key };
        }
        const [result] = await this.db.execute(query, [userId, name, keyHash]);
        return { id: Number(result.insertId), name, key };
    }

    async renameUserApiKey(userId, keyId, name) {
        await this.ready;
        const query = 'UPDATE user_api_keys SET name = ? WHERE user_id = ? AND id = ?';
        const params = [name, userId, keyId];
        const updated = this.config.type === 'sqlite'
            ? this.db.prepare(query).run(...params).changes === 1
            : (await this.db.execute(query, params))[0].affectedRows === 1;
        if (updated) return true;

        const selectQuery = 'SELECT id FROM user_api_keys WHERE user_id = ? AND id = ?';
        const row = this.config.type === 'sqlite'
            ? this.db.prepare(selectQuery).get(userId, keyId)
            : (await this.db.execute(selectQuery, [userId, keyId]))[0][0];
        return Boolean(row);
    }

    async rotateUserApiKey(userId, keyId) {
        await this.ready;
        const key = randomBytes(32).toString('base64url');
        const query = 'UPDATE user_api_keys SET key_hash = ? WHERE user_id = ? AND id = ?';
        const params = [hashPassword(key), userId, keyId];
        const updated = this.config.type === 'sqlite'
            ? this.db.prepare(query).run(...params).changes === 1
            : (await this.db.execute(query, params))[0].affectedRows === 1;
        return updated ? key : null;
    }

    async deleteUserApiKey(userId, keyId) {
        await this.ready;
        const query = 'DELETE FROM user_api_keys WHERE user_id = ? AND id = ?';
        if (this.config.type === 'sqlite') {
            return this.db.prepare(query).run(userId, keyId).changes === 1;
        }
        return (await this.db.execute(query, [userId, keyId]))[0].affectedRows === 1;
    }

    async listNumberPoolAccounts() {
        await this.ready;
        const query = 'SELECT uuid, `cookie-user-id` AS cookieUserId, password IS NOT NULL AS hasPassword, token_valid AS valid, validation_info AS info FROM number_pool ORDER BY uuid';
        return this.config.type === 'sqlite'
            ? this.db.prepare(query).all().map((account) => ({
                ...account,
                hasPassword: Boolean(account.hasPassword),
                valid: account.valid === null ? null : Boolean(account.valid),
            }))
            : (await this.db.query(query))[0].map((account) => ({
                ...account,
                hasPassword: Boolean(account.hasPassword),
                valid: account.valid === null ? null : Boolean(account.valid),
                info: account.info || '',
            }));
    }

    async getNumberPoolAccounts() {
        await this.ready;
        const query = 'SELECT uuid, token, password, `cookie-user-id` AS cookieUserId FROM number_pool ORDER BY uuid';
        return this.config.type === 'sqlite'
            ? this.db.prepare(query).all()
            : (await this.db.query(query))[0];
    }

    async getNumberPoolAccount(uuid) {
        await this.ready;
        const query = 'SELECT uuid, token, password, `cookie-user-id` AS cookieUserId FROM number_pool WHERE uuid = ?';
        if (this.config.type === 'sqlite') {
            return this.db.prepare(query).get(uuid) ?? null;
        }
        const [rows] = await this.db.execute(query, [uuid]);
        return rows[0] ?? null;
    }

    async createNumberPoolAccount(uuid, password, token = null) {
        await this.ready;
        const query = 'INSERT INTO number_pool (uuid, password, token, `cookie-user-id`, token_valid, validation_info) VALUES (?, ?, ?, NULL, NULL, ?)';
        if (this.config.type === 'sqlite') {
            this.db.prepare(query).run(uuid, password, token, '');
        } else {
            await this.db.execute(query, [uuid, password, token, '']);
        }
    }

    async deleteNumberPoolAccount(uuid) {
        await this.ready;
        const query = 'DELETE FROM number_pool WHERE uuid = ?';
        if (this.config.type === 'sqlite') {
            return this.db.prepare(query).run(uuid).changes === 1;
        }
        return (await this.db.execute(query, [uuid]))[0].affectedRows === 1;
    }

    async updateNumberPoolPassword(uuid, password) {
        await this.ready;
        const query = "UPDATE number_pool SET password = ?, token = NULL, `cookie-user-id` = NULL, token_valid = NULL, validation_info = '' WHERE uuid = ?";
        if (this.config.type === 'sqlite') {
            return this.db.prepare(query).run(password, uuid).changes === 1;
        }
        return (await this.db.execute(query, [password, uuid]))[0].affectedRows === 1;
    }

    async validateBearerToken(key) {
        await this.ready;
        const query = `
            SELECT user_api_keys.user_id AS id
            FROM user_api_keys
            INNER JOIN users ON users.id = user_api_keys.user_id
            WHERE user_api_keys.key_hash = ?
            UNION ALL
            SELECT bearer_tokens.id
            FROM bearer_tokens
            INNER JOIN users ON users.id = bearer_tokens.id
            WHERE bearer_tokens.\`key\` = ?
            LIMIT 1
        `;
        const params = [hashPassword(key), key];

        if (this.config.type === 'sqlite') {
            return this.db.prepare(query).get(...params)?.id ?? null;
        }

        const [rows] = await this.db.execute(query, params);
        return rows[0]?.id ?? null;
    }

    async getRandomNumberPoolEntry() {
        await this.ready;
        const query = this.config.type === 'sqlite'
            ? 'SELECT uuid, token, password, `cookie-user-id` AS cookieUserId FROM number_pool ORDER BY RANDOM() LIMIT 1'
            : 'SELECT uuid, token, password, `cookie-user-id` AS cookieUserId FROM number_pool ORDER BY RAND() LIMIT 1';

        if (this.config.type === 'sqlite') {
            return this.db.prepare(query).get() ?? null;
        }

        const [rows] = await this.db.query(query);
        return rows[0] ?? null;
    }

    async updateNumberPoolToken(uuid, token, cookieUserId) {
        await this.ready;
        const query = 'UPDATE number_pool SET token = ?, `cookie-user-id` = ? WHERE uuid = ?';

        if (this.config.type === 'sqlite') {
            const result = this.db.prepare(query).run(token, cookieUserId, uuid);
            return result.changes === 1;
        }

        const [result] = await this.db.execute(query, [token, cookieUserId, uuid]);
        return result.affectedRows === 1;
    }

    async updateNumberPoolValidation(uuid, valid, info) {
        await this.ready;
        const query = 'UPDATE number_pool SET token_valid = ?, validation_info = ? WHERE uuid = ?';
        const params = [valid ? 1 : 0, info, uuid];
        if (this.config.type === 'sqlite') {
            return this.db.prepare(query).run(...params).changes === 1;
        }
        const [result] = await this.db.execute(query, params);
        return result.affectedRows === 1;
    }
}

const db = new UserDatabase();

export { adminPermissions, knownPermissions };
export default db;
