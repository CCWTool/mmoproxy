import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
    createPaymentUrl,
    hashVoucher,
    newOrderNumber,
    newVoucherCode,
    verifyEpayCallback,
    yuanToFen,
} from '../../src/backend/payment.js';

function sign(params, key) {
    const data = Object.entries(params)
        .filter(([name, value]) => value && name !== 'sign' && name !== 'sign_type')
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([name, value]) => `${name}=${value}`)
        .join('&');
    return createHash('md5').update(`${data}${key}`).digest('hex');
}

test('parses yuan amounts without floating-point conversion', () => {
    assert.equal(yuanToFen('0.10'), 10);
    assert.equal(yuanToFen('12'), 1200);
    assert.equal(yuanToFen('12.3'), 1230);
    assert.equal(yuanToFen('1.001'), null);
    assert.equal(yuanToFen('-1'), null);
});

test('generates cryptographically random 256-bit hexadecimal vouchers and unique orders', () => {
    const code = newVoucherCode();
    assert.match(code, /^[a-f0-9]{64}$/);
    assert.equal(hashVoucher(code).length, 64);
    assert.match(newOrderNumber(), /^[a-f0-9]{32}$/);
});

test('verifies the signed Epay callback fields', () => {
    const key = 'test-epay-secret';
    const params = {
        pid: 'merchant-1',
        money: '1.00',
        out_trade_no: 'order-1',
        trade_no: 'trade-1',
        trade_status: 'TRADE_SUCCESS',
        sign_type: 'MD5',
    };
    params.sign = sign(params, key);
    assert.equal(verifyEpayCallback(params, key), true);
    assert.equal(verifyEpayCallback({ ...params, money: '2.00' }, key), false);
    assert.equal(verifyEpayCallback({ ...params, sign: 'invalid' }, key), false);
});

test('creates a payment checkout URL with configured Epay credentials', () => {
    const original = {
        EPAY_PID: process.env.EPAY_PID,
        EPAY_KEY: process.env.EPAY_KEY,
        EPAY_URL: process.env.EPAY_URL,
        EPAY_TYPE: process.env.EPAY_TYPE,
    };
    Object.assign(process.env, {
        EPAY_PID: 'merchant-1',
        EPAY_KEY: 'secret',
        EPAY_URL: 'https://pay.example.test/',
        EPAY_TYPE: 'alipay',
    });
    try {
        const url = createPaymentUrl({
            amountFen: 1234,
            orderNo: 'order-1',
            baseUrl: 'https://proxy.example.test',
        });
        assert.match(url, /^https:\/\/pay\.example\.test\/submit\.php\?/);
        assert.match(url, /money=12\.34/);
        assert.match(url, /out_trade_no=order-1/);
        assert.match(url, /notify_url=https:\/\/proxy\.example\.test\/api\/payments\/epay\/notify/);
    } finally {
        for (const [key, value] of Object.entries(original)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
});
