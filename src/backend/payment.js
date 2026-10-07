import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import yifanepay from 'yifanepay';

const yuanToFen = (value) => {
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    const normalized = String(value);
    if (!/^\d{1,7}(?:\.\d{1,2})?$/.test(normalized)) return null;
    const [yuan, fraction = ''] = normalized.split('.');
    return Number(yuan) * 100 + Number(fraction.padEnd(2, '0'));
};

function verifyEpayCallback(params, key) {
    const received = typeof params.sign === 'string' ? params.sign.toLowerCase() : '';
    if (!/^[a-f0-9]{32}$/.test(received)) return false;

    const signedData = Object.entries(params)
        .filter(([name, value]) => value && name !== 'sign' && name !== 'sign_type')
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([name, value]) => `${name}=${value}`)
        .join('&');
    const expected = createHash('md5').update(`${signedData}${key}`).digest();
    return timingSafeEqual(Buffer.from(received, 'hex'), expected);
}

function getPaymentTypes() {
    const configuredTypes = (process.env.EPAY_TYPE || 'alipay')
        .split(',')
        .map((type) => type.trim())
        .filter(Boolean);
    return configuredTypes.length > 0 ? configuredTypes : ['alipay'];
}

function createPaymentUrl({ amountFen, orderNo, baseUrl, paymentType }) {
    const { EPAY_PID: pid, EPAY_KEY: key, EPAY_URL: gatewayUrl } = process.env;
    if (!pid || !key || !gatewayUrl) throw new Error('易支付参数未配置，请联系管理员。');

    const type = paymentType || getPaymentTypes()[0];
    if (!getPaymentTypes().includes(type)) throw new Error('不支持的支付方式。');

    let gateway;
    try {
        gateway = new URL(gatewayUrl);
    } catch (error) {
        throw new Error('易支付地址配置无效。', { cause: error });
    }
    if (!['http:', 'https:'].includes(gateway.protocol)) {
        throw new Error('易支付地址必须使用 HTTP 或 HTTPS。');
    }

    const origin = (process.env.APP_BASE_URL || baseUrl).replace(/\/+$/, '');
    const data = {
        pid,
        money: (amountFen / 100).toFixed(2),
        name: '账户余额充值',
        notify_url: `${origin}/api/payments/epay/notify`,
        out_trade_no: orderNo,
        return_url: `${origin}/`,
        sitename: process.env.EPAY_SITENAME || 'mmoproxy',
        type,
    };
    return yifanepay.outcome(key, `${gateway.toString().replace(/\/?$/, '/')}`, data);
}

function newOrderNumber() {
    return randomBytes(16).toString('hex');
}

function hashVoucher(code) {
    return createHash('sha256').update(code, 'utf8').digest('hex');
}

function newVoucherCode() {
    return randomBytes(32).toString('hex');
}

export {
    createPaymentUrl,
    getPaymentTypes,
    hashVoucher,
    newOrderNumber,
    newVoucherCode,
    verifyEpayCallback,
    yuanToFen,
};
