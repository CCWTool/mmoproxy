import { useEffect, useState } from 'react';
import GitHubLink from './GitHubLink.jsx';

const permissionOptions = [
  ['user.plan.read', '查看套餐'],
  ['user.key', '管理自己的密钥'],
  ['admin.users.read', '查看用户'],
  ['admin.users.edit', '管理用户'],
  ['admin.pool.read', '查看号池'],
  ['admin.pool.edit', '管理号池'],
  ['admin.config.rw', '系统设置'],
];

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'same-origin',
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });
  const contentType = response.headers.get('content-type') || '';
  const result = contentType.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) throw new Error(result.message || `请求失败 (${response.status})`);
  return result;
}

function Readme({ markdown }) {
  const lines = markdown.split(/\r?\n/);
  const blocks = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    if (line.startsWith('```')) {
      const code = [];
      index += 1;
      while (index < lines.length && !lines[index].startsWith('```')) code.push(lines[index++]);
      index += 1;
      blocks.push(<pre className="readme-code" key={`code-${index}`}><code>{code.join('\n')}</code></pre>);
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      const Heading = `h${Math.min(heading[1].length + 1, 5)}`;
      blocks.push(<Heading className="readme-heading" key={`heading-${index}`}>{heading[2]}</Heading>);
      index += 1;
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index])) {
        items.push(<li key={index}>{lines[index++].replace(/^\s*[-*]\s+/, '')}</li>);
      }
      blocks.push(<ul className="readme-list" key={`list-${index}`}>{items}</ul>);
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quote = [];
      while (index < lines.length && /^>\s?/.test(lines[index])) quote.push(lines[index++].replace(/^>\s?/, ''));
      blocks.push(<blockquote key={`quote-${index}`}>{quote.join(' ')}</blockquote>);
      continue;
    }

    const paragraph = [line];
    index += 1;
    while (index < lines.length && lines[index].trim() && !/^(#{1,4}\s|```|>\s?)/.test(lines[index]) && !/^\s*[-*]\s+/.test(lines[index])) {
      paragraph.push(lines[index++]);
    }
    blocks.push(<p key={`paragraph-${index}`}>{paragraph.join(' ')}</p>);
  }

  return <div className="readme-content">{blocks}</div>;
}

function PermissionTags({ permissions }) {
  return (
    <div className="permission-tags">
      {permissions.map((permission) => (
        <span className="permission-tag" key={permission}>{permission}</span>
      ))}
    </div>
  );
}

const paymentTypeNames = {
  alipay: '支付宝支付',
  wxpay: '微信支付',
  usdt: 'USDT(TRC20) 支付',
};

const sectionLabels = {
  home: '首页',
  plan: '套餐',
  account: '个人中心',
  keys: '密钥管理',
  users: '用户管理',
  pool: '号池管理',
  settings: '系统设置',
};

function getSectionFromPath() {
  const path = window.location.pathname.replace(/^\/+|\/+$/g, '');
  return Object.hasOwn(sectionLabels, path) ? path : 'home';
}

export default function Dashboard({ user, onLogout }) {
  const [section, setSection] = useState(getSectionFromPath);
  const [readme, setReadme] = useState('');
  const [users, setUsers] = useState(null);
  const [accounts, setAccounts] = useState(null);
  const [userKeys, setUserKeys] = useState(null);
  const [profile, setProfile] = useState(null);
  const [rechargeAmount, setRechargeAmount] = useState('10.00');
  const [paymentTypes, setPaymentTypes] = useState(null);
  const [paymentType, setPaymentType] = useState(null);
  const [voucherCode, setVoucherCode] = useState('');
  const [configuration, setConfiguration] = useState(null);
  const [voucherAmount, setVoucherAmount] = useState('10.00');
  const [issuedVoucher, setIssuedVoucher] = useState(null);
  const [createdApiKey, setCreatedApiKey] = useState(null);
  const [newApiKeyName, setNewApiKeyName] = useState('');
  const [editingApiKeyId, setEditingApiKeyId] = useState(null);
  const [editingApiKeyName, setEditingApiKeyName] = useState('');
  const [expandedUser, setExpandedUser] = useState(null);
  const [newUsername, setNewUsername] = useState('');
  const [newUserPassword, setNewUserPassword] = useState('');
  const [newUserPermissions, setNewUserPermissions] = useState(['user.plan.read']);
  const [newPoolUuid, setNewPoolUuid] = useState('');
  const [newPoolPassword, setNewPoolPassword] = useState('');
  const [newPoolToken, setNewPoolToken] = useState('');
  const [newPoolCredentialType, setNewPoolCredentialType] = useState('password');
  const [passwordEdits, setPasswordEdits] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const canReadUsers = user.permissions.includes('admin.users.read') || user.permissions.includes('admin.users.edit');
  const canEditUsers = user.permissions.includes('admin.users.edit');
  const canReadPool = user.permissions.includes('admin.pool.read') || user.permissions.includes('admin.pool.edit');
  const canEditPool = user.permissions.includes('admin.pool.edit');
  const canManageKeys = user.permissions.includes('user.key');
  const canReadPlan = user.permissions.includes('user.plan.read');
  const canManageConfig = user.permissions.includes('admin.config.rw');
  const navigation = [
    { id: 'home', label: sectionLabels.home, icon: '⌂', visible: true },
    { id: 'plan', label: sectionLabels.plan, icon: '◉', visible: canReadPlan },
    { id: 'account', label: sectionLabels.account, icon: '♙', visible: true },
    { id: 'keys', label: sectionLabels.keys, icon: '⚿', visible: canManageKeys },
    { id: 'users', label: sectionLabels.users, icon: '♙', visible: canReadUsers },
    { id: 'pool', label: sectionLabels.pool, icon: '▦', visible: canReadPool },
    { id: 'settings', label: sectionLabels.settings, icon: '⚙', visible: canManageConfig },
  ].filter((item) => item.visible);
  const activeSection = navigation.some((item) => item.id === section) ? section : 'home';

  useEffect(() => {
    const syncSectionFromPath = () => {
      const nextSection = getSectionFromPath();
      if (!navigation.some((item) => item.id === nextSection)) {
        window.history.replaceState({ section: 'home' }, '', '/');
        setSection('home');
        return;
      }
      setSection(nextSection);
    };
    window.addEventListener('popstate', syncSectionFromPath);
    return () => window.removeEventListener('popstate', syncSectionFromPath);
  }, [canManageConfig, canManageKeys, canReadPlan, canReadPool, canReadUsers]);

  useEffect(() => {
    const path = activeSection === 'home' ? '/' : `/${activeSection}`;
    if (window.location.pathname !== path) {
      window.history.replaceState({ section: activeSection }, '', path);
    }
    document.title = `${sectionLabels[activeSection]} · mmoproxy`;
  }, [activeSection]);

  useEffect(() => {
    if (activeSection === 'account') {
      api('/api/user/profile')
        .then((userProfile) => {
          setProfile(userProfile);
          setPaymentTypes(userProfile.paymentTypes);
          setPaymentType(userProfile.paymentTypes[0] || null);
        })
        .catch((loadError) => setError(loadError.message));
    }
    if (activeSection === 'settings' && canManageConfig) {
      api('/api/admin/config')
        .then(({ content }) => setConfiguration(content))
        .catch((loadError) => setError(loadError.message));
    }
    if (activeSection === 'home' && !readme) {
      api('/api/touser')
        .then(setReadme)
        .catch((loadError) => setError(loadError.message));
    }
    if (activeSection === 'users' && canReadUsers) {
      api('/api/admin/users')
        .then(({ users: rows }) => setUsers(rows))
        .catch((loadError) => setError(loadError.message));
    }
    if (activeSection === 'pool' && canReadPool) {
      api('/api/admin/pool')
        .then(({ accounts: rows }) => setAccounts(rows))
        .catch((loadError) => setError(loadError.message));
    }
    if (activeSection === 'keys' && canManageKeys) {
      api('/api/user/keys')
        .then(({ keys }) => setUserKeys(keys))
        .catch((loadError) => setError(loadError.message));
    }
  }, [activeSection, canManageConfig, canManageKeys, canReadPool, canReadUsers, readme]);

  async function runAction(action, message) {
    setBusy(true);
    setError('');
    setNotice('');
    setCreatedApiKey(null);
    try {
      await action();
      setNotice(message);
    } catch (actionError) {
      setError(actionError.message);
    } finally {
      setBusy(false);
    }
  }

  function togglePermission(permission, checked) {
    setNewUserPermissions((current) => checked
      ? [...current, permission]
      : current.filter((item) => item !== permission));
  }

  async function createUser(event) {
    event.preventDefault();
    await runAction(async () => {
      await api('/api/admin/users', {
        method: 'POST',
        body: JSON.stringify({ username: newUsername, password: newUserPassword, permissions: newUserPermissions }),
      });
      setNewUsername('');
      setNewUserPassword('');
      setNewUserPermissions(['user.plan.read']);
      setUsers(await api('/api/admin/users').then((result) => result.users));
    }, '用户已创建。');
  }

  async function savePermissions(id, permissions) {
    await runAction(async () => {
      await api(`/api/admin/users/${id}/permissions`, {
        method: 'PUT',
        body: JSON.stringify({ permissions }),
      });
      setUsers(await api('/api/admin/users').then((result) => result.users));
    }, '用户权限已更新。');
  }

  async function createApiKey() {
    await runAction(async () => {
      const { apiKey } = await api('/api/user/keys', {
        method: 'POST',
        body: JSON.stringify({ name: newApiKeyName }),
      });
      setCreatedApiKey(apiKey);
      setNewApiKeyName('');
      setUserKeys(await api('/api/user/keys').then((result) => result.keys));
    }, '密钥已创建。请立即保存，之后将无法再次查看。');
  }

  async function renameApiKey(event, id) {
    event.preventDefault();
    await runAction(async () => {
      await api(`/api/user/keys/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ name: editingApiKeyName }),
      });
      setUserKeys(await api('/api/user/keys').then((result) => result.keys));
      setEditingApiKeyId(null);
      setEditingApiKeyName('');
    }, '密钥名称已更新。');
  }

  async function rotateApiKey(id) {
    const apiKey = userKeys.find((key) => key.id === id);
    if (!window.confirm(`轮换“${apiKey?.name || '未命名密钥'}”？旧密钥将立即失效。`)) return;
    await runAction(async () => {
      const { apiKey: rotatedApiKey } = await api(`/api/user/keys/${id}/rotate`, { method: 'POST' });
      setCreatedApiKey({ ...rotatedApiKey, name: apiKey?.name || '未命名密钥' });
      setUserKeys(await api('/api/user/keys').then((result) => result.keys));
    }, '密钥已轮换。请立即保存新密钥，之后将无法再次查看。');
  }

  async function removeApiKey(id) {
    const apiKey = userKeys.find((key) => key.id === id);
    if (!window.confirm(`确定移除“${apiKey?.name || '未命名密钥'}”吗？使用该密钥的连接将无法重新建立。`)) return;
    await runAction(async () => {
      await api(`/api/user/keys/${id}`, { method: 'DELETE' });
      setUserKeys(await api('/api/user/keys').then((result) => result.keys));
    }, '密钥已移除。');
  }

  async function logout() {
    setBusy(true);
    setError('');
    try {
      await onLogout();
    } catch (logoutError) {
      setError(logoutError.message || '退出登录失败，请重试。');
      setBusy(false);
    }
  }

  async function changeUserPassword(event, id) {
    event.preventDefault();
    const password = passwordEdits[id];
    await runAction(async () => {
      await api(`/api/admin/users/${id}/password`, { method: 'PUT', body: JSON.stringify({ password }) });
      setPasswordEdits((current) => ({ ...current, [id]: '' }));
    }, '用户密码已更新。');
  }

  async function createPoolAccount(event) {
    event.preventDefault();
    await runAction(async () => {
      const credentials = newPoolCredentialType === 'password'
        ? { password: newPoolPassword }
        : { token: newPoolToken };
      await api('/api/admin/pool', {
        method: 'POST',
        body: JSON.stringify({ uuid: newPoolUuid, ...credentials }),
      });
      setNewPoolUuid('');
      setNewPoolPassword('');
      setNewPoolToken('');
      setAccounts(await api('/api/admin/pool').then((result) => result.accounts));
    }, '号池账号已添加。');
  }

  async function changePoolPassword(event, uuid) {
    event.preventDefault();
    await runAction(async () => {
      await api(`/api/admin/pool/${encodeURIComponent(uuid)}/password`, {
        method: 'PUT',
        body: JSON.stringify({ password: passwordEdits[uuid] }),
      });
      setPasswordEdits((current) => ({ ...current, [uuid]: '' }));
      setAccounts(await api('/api/admin/pool').then((result) => result.accounts));
    }, '号池账号密码已更新，登录凭据将在下次使用时刷新。');
  }

  async function loginPoolAccount(uuid) {
    await runAction(async () => {
      await api(`/api/admin/pool/${encodeURIComponent(uuid)}/login`, { method: 'POST' });
      setAccounts(await api('/api/admin/pool').then((result) => result.accounts));
    }, '账号已登录，Token 已保存。');
  }

  async function removePoolAccount(uuid) {
    if (!window.confirm(`确定移除号池账号 ${uuid} 吗？`)) return;
    await runAction(async () => {
      await api(`/api/admin/pool/${encodeURIComponent(uuid)}`, { method: 'DELETE' });
      setAccounts(await api('/api/admin/pool').then((result) => result.accounts));
      setPasswordEdits((current) => {
        const remaining = { ...current };
        delete remaining[uuid];
        return remaining;
      });
    }, '号池账号已移除。');
  }

  async function startRecharge(event) {
    event.preventDefault();
    await runAction(async () => {
      const { paymentUrl: url } = await api('/api/user/recharge', {
        method: 'POST',
        body: JSON.stringify({ amount: rechargeAmount, paymentType }),
      });
      window.location.assign(url);
    }, '正在前往支付页面。');
  }

  async function redeemVoucher(event) {
    event.preventDefault();
    await runAction(async () => {
      await api('/api/user/vouchers/redeem', {
        method: 'POST',
        body: JSON.stringify({ code: voucherCode.trim() }),
      });
      setVoucherCode('');
      setProfile(await api('/api/user/profile'));
      setPaymentUrl('');
    }, '兑换成功，余额已更新。');
  }

  async function saveConfiguration(event) {
    event.preventDefault();
    await runAction(async () => {
      await api('/api/admin/config', {
        method: 'PUT',
        body: JSON.stringify({ content: configuration }),
      });
    }, '.env 已保存，运行中的易支付配置已重载。');
  }

  async function issueVoucher(event) {
    event.preventDefault();
    await runAction(async () => {
      const result = await api('/api/admin/vouchers', {
        method: 'POST',
        body: JSON.stringify({ amount: voucherAmount }),
      });
      setIssuedVoucher(result);
    }, '兑换码已生成，请立即复制保存。');
  }

  const formatMoney = (fen) => `¥${(Number(fen || 0) / 100).toFixed(2)}`;

  return (
    <div className="dashboard">
      <aside className="dashboard-sidebar">
        <div className="dashboard-brand-group">
          <a className="brand dashboard-brand" href="/" aria-label="mmoproxy 首页">
            <span className="brand-mark" aria-hidden="true">m</span>
            <span className="brand-name">mmoproxy</span>
          </a>
          <GitHubLink />
        </div>
        <p className="sidebar-caption">工作空间</p>
        <nav className="sidebar-nav" aria-label="主导航">
          {navigation.map((item) => (
            <button
              className={`nav-item${activeSection === item.id ? ' active' : ''}`}
              type="button"
              key={item.id}
              onClick={() => {
                const path = item.id === 'home' ? '/' : `/${item.id}`;
                if (window.location.pathname !== path) {
                  window.history.pushState({ section: item.id }, '', path);
                }
                setSection(item.id);
                setError('');
                setNotice('');
                setCreatedApiKey(null);
                setIssuedVoucher(null);
              }}
            >
              <span className="nav-icon" aria-hidden="true">{item.icon}</span>
              {item.label}
              {activeSection === item.id && <span className="nav-active-mark" />}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <span className="sidebar-status"><i />服务正常</span>
          <span className="sidebar-version">MMOPROXY WORKSPACE</span>
        </div>
      </aside>

      <main className="dashboard-main">
        <header className="dashboard-topbar">
          <div className="breadcrumb"><span>工作空间</span><b>/</b>{navigation.find((item) => item.id === activeSection)?.label}</div>
          <div className="account-menu">
            <span className="account-avatar">{user.username.slice(0, 1).toUpperCase()}</span>
            <span className="account-name">{user.username}</span>
            <button className="logout-button" onClick={logout} type="button" disabled={busy}>退出</button>
          </div>
        </header>

        <section className="dashboard-content">
          {error && <div className="dashboard-alert error" role="alert">{error}</div>}
          {notice && <div className="dashboard-alert success" role="status">{notice}</div>}

          {activeSection === 'home' && (
            <div className="content-card readme-card">
              <div className="page-heading">
                <div><p className="page-eyebrow">DOCUMENTATION</p><h1>项目说明</h1></div>
                <span className="file-pill">TOUSER.md</span>
              </div>
              {readme ? <Readme markdown={readme} /> : <p className="loading-note">正在读取项目文档…</p>}
            </div>
          )}

          {activeSection === 'plan' && canReadPlan && (
            <>
              <div className="page-heading">
                <div><p className="page-eyebrow">BILLING PLAN</p><h1>套餐</h1><p className="page-subtitle">连接 WebSocket 代理时按使用时长计费。</p></div>
              </div>
              <div className="content-card plan-card selected">
                <div className="plan-card-heading">
                  <div><span className="plan-indicator" /><div><h2>按量计费</h2><p>默认套餐</p></div></div>
                  <span className="plan-price">¥0.1 <small>/ 分钟</small></span>
                </div>
                <p className="plan-description">每条成功建立的代理连接按开始使用的分钟数扣费；余额不足时将无法连接或连接会结束。</p>
                <span className="plan-default-tag">当前默认</span>
              </div>
            </>
          )}

          {activeSection === 'account' && (
            <>
              <div className="page-heading">
                <div><p className="page-eyebrow">PERSONAL CENTER</p><h1>个人中心</h1></div>
              </div>
              <div className="account-summary content-card">
                <div><span>用户名</span><strong>{profile?.username ?? '--'}</strong></div>
                <div><span>余额</span><strong>{profile ? formatMoney(profile.balanceFen) : '--'}</strong></div>
              </div>
              <div className="content-card billing-card">
                <div className="card-heading"><div><h2>充值</h2><p>支持易支付在线充值，支付成功后余额自动到账。</p></div></div>
                <form className="key-create-form recharge-form" onSubmit={startRecharge}>
                  <label><span>充值金额（元）</span><input type="number" min="1" max="1000000" step="0.01" value={rechargeAmount} onChange={(event) => setRechargeAmount(event.target.value)} required /></label>
                  <fieldset className="payment-methods">
                    <legend>支付方式</legend>
                    {paymentTypes === null
                      ? <span>--</span>
                      : paymentTypes.length
                        ? paymentTypes.map((type) => (
                          <label className={`payment-method-option${paymentType === type ? ' selected' : ''}`} key={type}>
                            <input type="radio" name="paymentType" value={type} checked={paymentType === type} onChange={() => setPaymentType(type)} />
                            <span>{paymentTypeNames[type] || type}</span>
                          </label>
                        ))
                        : <span>暂无可用支付方式</span>}
                  </fieldset>
                  <button className="primary-button" type="submit" disabled={busy || !paymentType}>确定</button>
                </form>
              </div>
              <div className="content-card billing-card">
                <div className="card-heading"><div><h2>兑换码</h2><p>输入 256 位十六进制兑换码，成功兑换后余额即时增加。</p></div></div>
                <form className="key-create-form" onSubmit={redeemVoucher}>
                  <label><span>兑换码</span><input className="voucher-input" value={voucherCode} onChange={(event) => setVoucherCode(event.target.value)} maxLength={64} minLength={64} pattern="[a-fA-F0-9]{64}" required placeholder="64 位十六进制字符串" /></label>
                  <button className="primary-button" type="submit" disabled={busy}>兑换</button>
                </form>
              </div>
            </>
          )}

          {activeSection === 'settings' && canManageConfig && (
            <>
              <div className="page-heading">
                <div><p className="page-eyebrow">SYSTEM CONFIGURATION</p><h1>系统设置</h1><p className="page-subtitle">保存后立即重载当前进程中的易支付配置。</p></div>
              </div>
              <form className="content-card configuration-card" onSubmit={saveConfiguration}>
                <div className="card-heading"><div><h2>.env 配置文件</h2><p>此文件包含敏感凭据，仅有系统设置权限的管理员可查看和修改。</p></div></div>
                <textarea aria-label=".env 配置文件" spellCheck="false" value={configuration ?? ''} placeholder={configuration === null ? '--' : undefined} disabled={configuration === null} onChange={(event) => setConfiguration(event.target.value)} />
                <button className="primary-button" type="submit" disabled={busy || configuration === null}>保存并重载</button>
              </form>
              {issuedVoucher && (
                <div className="key-reveal voucher-reveal" role="status">
                  <div><strong>新兑换码 — 仅显示一次</strong><p>金额 {formatMoney(issuedVoucher.amountFen)}。兑换码以 256 位十六进制数生成，请妥善保存。</p><code>{issuedVoucher.code}</code></div>
                  <button className="text-button" type="button" onClick={() => setIssuedVoucher(null)}>已保存</button>
                </div>
              )}
              <form className="content-card create-form" onSubmit={issueVoucher}>
                <div className="card-heading"><div><h2>生成兑换码</h2><p>生成的兑换码只能成功兑换一次。</p></div></div>
                <div className="form-grid"><label>面额（元）<input type="number" min="0.01" max="1000000" step="0.01" value={voucherAmount} onChange={(event) => setVoucherAmount(event.target.value)} required /></label></div>
                <button className="primary-button" type="submit" disabled={busy}>生成兑换码</button>
              </form>
            </>
          )}

          {activeSection === 'keys' && canManageKeys && (
            <>
              <div className="page-heading">
                <div><p className="page-eyebrow">WEBSOCKET ACCESS</p><h1>密钥管理</h1><p className="page-subtitle">使用密钥通过 Bearer 认证连接 WebSocket 代理。</p></div>
                <span className="count-pill">{userKeys === null ? '--' : userKeys.length} 个密钥</span>
              </div>
              {createdApiKey && (
                <div className="key-reveal" role="status">
                  <div>
                    <strong>{createdApiKey.name} — 仅显示一次</strong>
                    <p>请立即复制并妥善保存。离开此页面后将无法再次查看。</p>
                    <code>{createdApiKey.key}</code>
                  </div>
                  <button className="text-button" type="button" onClick={() => setCreatedApiKey(null)}>我已保存</button>
                </div>
              )}
              <div className="content-card key-management">
                <div className="card-heading"><div><h2>你的密钥</h2><p>密钥由系统安全保存；轮换会立即使旧密钥失效。</p></div></div>
                <form className="key-create-form" onSubmit={(event) => { event.preventDefault(); createApiKey(); }}>
                  <label>
                    <span>密钥名称</span>
                    <input
                      value={newApiKeyName}
                      onChange={(event) => setNewApiKeyName(event.target.value)}
                      maxLength={64}
                      required
                      placeholder="例如：家用电脑"
                    />
                  </label>
                  <button className="primary-button" type="submit" disabled={busy || !newApiKeyName.trim()}>新建密钥</button>
                </form>
                <div className="key-list">
                  {userKeys?.map((key) => (
                    <div className="key-row" key={key.id}>
                      {editingApiKeyId === key.id ? (
                        <form className="key-rename-form" onSubmit={(event) => renameApiKey(event, key.id)}>
                          <input aria-label="密钥名称" value={editingApiKeyName} onChange={(event) => setEditingApiKeyName(event.target.value)} maxLength={64} required />
                          <button className="text-button" type="submit" disabled={busy || !editingApiKeyName.trim()}>保存</button>
                          <button className="text-button" type="button" onClick={() => setEditingApiKeyId(null)} disabled={busy}>取消</button>
                        </form>
                      ) : (
                        <span><strong>{key.name || '未命名密钥'}</strong><small>密钥内容不会再次显示</small></span>
                      )}
                      <div className="row-actions">
                        {editingApiKeyId !== key.id && (
                          <button
                            className="text-button"
                            type="button"
                            onClick={() => { setEditingApiKeyId(key.id); setEditingApiKeyName(key.name || ''); }}
                            disabled={busy}
                          >重命名</button>
                        )}
                        <button className="text-button" type="button" onClick={() => rotateApiKey(key.id)} disabled={busy}>轮换</button>
                        <button className="text-button remove-button" type="button" onClick={() => removeApiKey(key.id)} disabled={busy}>移除</button>
                      </div>
                    </div>
                  ))}
                  {userKeys === null && <p className="key-empty">--</p>}
                  {userKeys && !userKeys.length && <p className="key-empty">尚未创建密钥。</p>}
                </div>
              </div>
            </>
          )}

          {activeSection === 'users' && (
            <>
              <div className="page-heading">
                <div><p className="page-eyebrow">ACCESS CONTROL</p><h1>用户管理</h1><p className="page-subtitle">查看用户、权限与关联数据。</p></div>
                <span className="count-pill">{users === null ? '--' : users.length} 位用户</span>
              </div>
              {canEditUsers && (
                <form className="content-card create-form" onSubmit={createUser}>
                  <div className="card-heading"><div><h2>新建用户</h2><p>新用户可使用用户名和密码登录。</p></div></div>
                  <div className="form-grid">
                    <label>用户名<input value={newUsername} onChange={(event) => setNewUsername(event.target.value)} maxLength={64} required /></label>
                    <label>初始密码<input type="password" value={newUserPassword} onChange={(event) => setNewUserPassword(event.target.value)} required /></label>
                  </div>
                  <fieldset className="permission-picker">
                    <legend>授予权限</legend>
                    {permissionOptions.map(([permission, label]) => (
                      <label key={permission}><input type="checkbox" checked={newUserPermissions.includes(permission)} onChange={(event) => togglePermission(permission, event.target.checked)} />{label}</label>
                    ))}
                  </fieldset>
                  <button className="primary-button" type="submit" disabled={busy}>创建用户</button>
                </form>
              )}
              <div className="content-card table-card">
                <div className="card-heading"><div><h2>用户列表</h2><p>用户密码仅保存为 SHA-256 摘要。</p></div></div>
                <div className="table-scroll">
                  <table>
                    <thead><tr><th>用户</th><th>权限</th><th>数据</th>{canEditUsers && <th>操作</th>}</tr></thead>
                    <tbody>
                      {users?.map((row) => (
                        <tr key={row.id}>
                          <td><div className="table-user"><span className="table-avatar">{row.username.slice(0, 1).toUpperCase()}</span><span>{row.username}<small>ID {row.id}</small></span></div></td>
                          <td><PermissionTags permissions={row.permissions} /></td>
                          <td><code className="data-preview">{JSON.stringify(row.data)}</code></td>
                          {canEditUsers && (
                            <td>
                              <div className="row-actions">
                                <button className="text-button" type="button" onClick={() => setExpandedUser(expandedUser === row.id ? null : row.id)}>权限</button>
                              </div>
                              {expandedUser === row.id && (
                                <div className="user-tools">
                                  <p>权限设置</p>
                                  <div className="permission-picker compact">
                                    {permissionOptions.map(([permission, label]) => (
                                      <label key={permission}><input type="checkbox" checked={row.permissions.includes(permission)} disabled={busy} onChange={(event) => {
                                        const next = event.target.checked ? [...row.permissions, permission] : row.permissions.filter((item) => item !== permission);
                                        savePermissions(row.id, next);
                                      }} />{label}</label>
                                    ))}
                                  </div>
                                  <form className="inline-password-form" onSubmit={(event) => changeUserPassword(event, row.id)}>
                                    <input type="password" placeholder="设置新密码" value={passwordEdits[row.id] || ''} onChange={(event) => setPasswordEdits((current) => ({ ...current, [row.id]: event.target.value }))} required />
                                    <button className="text-button" type="submit" disabled={busy}>修改密码</button>
                                  </form>
                                </div>
                              )}
                            </td>
                          )}
                        </tr>
                      ))}
                      {users === null && <tr><td className="empty-row" colSpan={canEditUsers ? 4 : 3}>--</td></tr>}
                      {users && !users.length && <tr><td className="empty-row" colSpan={canEditUsers ? 4 : 3}>暂无用户。</td></tr>}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}

          {activeSection === 'pool' && (
            <>
              <div className="page-heading">
                <div><p className="page-eyebrow">ACCOUNT POOL</p><h1>号池管理</h1><p className="page-subtitle">账号密码不会显示在界面中。</p></div>
                <span className="count-pill">{accounts === null ? '--' : accounts.length} 个账号</span>
              </div>
              {canEditPool && (
                <form className="content-card create-form" onSubmit={createPoolAccount}>
                  <div className="card-heading"><div><h2>添加号池账号</h2><p>可添加密码账号或仅 token 账号。</p></div></div>
                  <div className="form-grid">
                    <label>账号 UUID<input value={newPoolUuid} onChange={(event) => setNewPoolUuid(event.target.value)} maxLength={255} required /></label>
                    <label>凭据类型<select value={newPoolCredentialType} onChange={(event) => setNewPoolCredentialType(event.target.value)}><option value="password">账号密码</option><option value="token">仅 token</option></select></label>
                    {newPoolCredentialType === 'password'
                      ? <label>账号密码<input type="password" value={newPoolPassword} onChange={(event) => setNewPoolPassword(event.target.value)} required /></label>
                      : <label>Token<input value={newPoolToken} onChange={(event) => setNewPoolToken(event.target.value)} maxLength={4096} required /></label>}
                  </div>
                  <button className="primary-button" type="submit" disabled={busy}>添加账号</button>
                </form>
              )}
              <div className="content-card table-card">
                <div className="card-heading"><div><h2>号池账号</h2><p>密码和 token 不会显示；修改密码后会清除旧登录凭据。</p></div></div>
                <div className="table-scroll">
                  <table>
                    <thead><tr><th>账号 UUID</th><th>用户标识</th><th>状态</th><th>信息</th><th>凭据</th>{canEditPool && <th>操作</th>}</tr></thead>
                    <tbody>
                      {accounts?.map((account) => (
                        <tr key={account.uuid}>
                          <td><code className="uuid-value">{account.uuid}</code></td>
                          <td>{account.cookieUserId || <span className="empty-note">登录后生成</span>}</td>
                          <td>{account.valid === null
                            ? <span className="pool-status pending">待验证</span>
                            : <span className={`pool-status ${account.valid ? 'valid' : 'invalid'}`}>{account.valid ? '有效' : '无效'}</span>}</td>
                          <td className="pool-info">{account.info || <span className="empty-note">—</span>}</td>
                          <td>{account.hasPassword ? '账号密码' : '仅 token'}</td>
                          {canEditPool && (
                            <td>
                              <div className="pool-row-actions">
                                {account.hasPassword && <button className="text-button" type="button" onClick={() => loginPoolAccount(account.uuid)} disabled={busy}>立即登录</button>}
                                <button className="text-button remove-button" type="button" onClick={() => removePoolAccount(account.uuid)} disabled={busy}>移除</button>
                              </div>
                              <form className="inline-password-form" onSubmit={(event) => changePoolPassword(event, account.uuid)}>
                                <input type="password" placeholder="输入新密码" value={passwordEdits[account.uuid] || ''} onChange={(event) => setPasswordEdits((current) => ({ ...current, [account.uuid]: event.target.value }))} required />
                                <button className="text-button" type="submit" disabled={busy}>修改密码</button>
                              </form>
                            </td>
                          )}
                        </tr>
                      ))}
                      {accounts === null && <tr><td className="empty-row" colSpan={canEditPool ? 6 : 5}>--</td></tr>}
                      {accounts && !accounts.length && <tr><td className="empty-row" colSpan={canEditPool ? 6 : 5}>号池暂时没有账号。</td></tr>}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </section>
      </main>
    </div>
  );
}
