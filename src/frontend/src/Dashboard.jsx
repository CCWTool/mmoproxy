import { useEffect, useState } from 'react';
import GitHubLink from './GitHubLink.jsx';
import {
  canChangeUserPassword,
  canChangeUserPermissions,
} from '../../backend/permission-delegation.js';

const permissionOptions = [
  ['user.plan.read', '查看套餐'],
  ['user.key', '管理自己的密钥'],
  ['admin.users.read', '查看用户'],
  ['admin.users.edit', '修改用户密码'],
  ['admin.users.permissions', '修改用户权限及创建用户'],
  ['admin.users.ban', '封禁/解封用户'],
  ['admin.users.plan', '修改用户套餐'],
  ['admin.users.balance', '修改用户余额'],
  ['admin.plan', '管理套餐及计费'],
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

function moneyToFen(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const match = String(value).match(/^(\d{1,7})(?:\.(\d{1,2}))?$/);
  if (!match) return null;
  return Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0'));
}

function hasActivePlan(profile, planId) {
  return profile?.planId === planId
    && (!profile.planExpiresAt || profile.planExpiresAt > Date.now());
}

const emptyPlan = {
  name: '',
  type: 'subscription',
  price: '0.00',
  durationDays: '30',
  httpsQuota: '-1',
  wssDurationMinutes: '-1',
  purchaseLimit: '-1',
  httpsOverage: '0.10',
  wssOverage: '0.10',
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
  const [editingUser, setEditingUser] = useState(null);
  const [userDraft, setUserDraft] = useState(null);
  const [newUsername, setNewUsername] = useState('');
  const [newUserPassword, setNewUserPassword] = useState('');
  const [newUserPermissions, setNewUserPermissions] = useState(['user.plan.read']);
  const [newPoolUuid, setNewPoolUuid] = useState('');
  const [newPoolPassword, setNewPoolPassword] = useState('');
  const [newPoolToken, setNewPoolToken] = useState('');
  const [newPoolCredentialType, setNewPoolCredentialType] = useState('password');
  const [passwordEdits, setPasswordEdits] = useState({});
  const [plans, setPlans] = useState(null);
  const [planType, setPlanType] = useState('subscription');
  const [billingRates, setBillingRates] = useState({ httpsPrice: '0.10', wssPrice: '0.10' });
  const [planForm, setPlanForm] = useState(emptyPlan);
  const [editingPlanId, setEditingPlanId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const canChangePassword = user.permissions.includes('admin.users.edit');
  const canChangeEditingUserPassword = canChangePassword
    && editingUser
    && canChangeUserPassword(user, editingUser);
  const canChangePermissions = user.permissions.includes('admin.users.permissions');
  const canChangeEditingUserPermissions = canChangePermissions
    && editingUser
    && canChangeUserPermissions(user, editingUser.id, editingUser);
  const canBanUsers = user.permissions.includes('admin.users.ban');
  const canChangeUserPlan = user.permissions.includes('admin.users.plan');
  const canChangeBalance = user.permissions.includes('admin.users.balance');
  const canManagePlans = user.permissions.includes('admin.plan');
  const canModifyUsers = canChangePassword || canChangePermissions || canBanUsers || canChangeUserPlan || canChangeBalance;
  const canReadUsers = user.permissions.includes('admin.users.read');
  const canReadPool = user.permissions.includes('admin.pool.read') || user.permissions.includes('admin.pool.edit');
  const canEditPool = user.permissions.includes('admin.pool.edit');
  const canManageKeys = user.permissions.includes('user.key');
  const canReadPlan = user.permissions.includes('user.plan.read');
  const canManageConfig = user.permissions.includes('admin.config.rw');
  const navigation = [
    { id: 'home', label: sectionLabels.home, icon: '⌂', visible: true },
    { id: 'plan', label: sectionLabels.plan, icon: '◉', visible: canReadPlan || canManagePlans },
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
  }, [canManageConfig, canManageKeys, canManagePlans, canReadPlan, canReadPool, canReadUsers]);

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
    if (activeSection === 'plan' && canReadPlan) {
      api('/api/user/profile')
        .then(setProfile)
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
    if ((activeSection === 'plan' && (canReadPlan || canManagePlans))
      || (activeSection === 'users' && canChangeUserPlan)) {
      api('/api/admin/plans')
        .then((result) => {
          setPlans(result.plans);
          setBillingRates({
            httpsPrice: (result.rates.httpsPriceFen / 100).toFixed(2),
            wssPrice: (result.rates.wssPriceFen / 100).toFixed(2),
          });
        })
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
  }, [activeSection, canChangeUserPlan, canManageConfig, canManageKeys, canManagePlans, canReadPlan, canReadPool, canReadUsers, readme]);

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

  function openUserEditor(row) {
    setEditingUser(row);
    setUserDraft({
      permissions: [...row.permissions],
      password: '',
      isBanned: row.isBanned,
      planId: row.planId === null ? '' : String(row.planId),
      balance: (row.balanceFen / 100).toFixed(2),
      balanceAdd: '0.00',
    });
  }

  async function saveUserChanges(event) {
    event.preventDefault();
    const changes = {};
    if (canChangePermissions
      && JSON.stringify(userDraft.permissions) !== JSON.stringify(editingUser.permissions)) {
      changes.permissions = userDraft.permissions;
    }
    if (canChangeEditingUserPassword && userDraft.password) changes.password = userDraft.password;
    if (canBanUsers && userDraft.isBanned !== editingUser.isBanned) changes.isBanned = userDraft.isBanned;
    if (canChangeUserPlan
      && (userDraft.planId ? Number(userDraft.planId) : null) !== editingUser.planId) {
      changes.planId = userDraft.planId ? Number(userDraft.planId) : null;
    }
    if (canChangeBalance) {
      const balanceFen = moneyToFen(userDraft.balance);
      const balanceDeltaFen = moneyToFen(userDraft.balanceAdd);
      if (balanceFen === null || balanceDeltaFen === null) {
        setError('余额金额格式无效。');
        return;
      }
      if (balanceFen !== editingUser.balanceFen) changes.balanceFen = balanceFen;
      if (balanceDeltaFen > 0) changes.balanceDeltaFen = balanceDeltaFen;
    }
    if (!Object.keys(changes).length) {
      setEditingUser(null);
      setUserDraft(null);
      return;
    }
    await runAction(async () => {
      await api(`/api/admin/users/${editingUser.id}`, {
        method: 'PUT',
        body: JSON.stringify(changes),
      });
      setUsers(await api('/api/admin/users').then((result) => result.users));
      setEditingUser(null);
      setUserDraft(null);
    }, '用户信息已保存。');
  }

  async function refreshPlans() {
    const result = await api('/api/admin/plans');
    setPlans(result.plans);
    setBillingRates({
      httpsPrice: (result.rates.httpsPriceFen / 100).toFixed(2),
      wssPrice: (result.rates.wssPriceFen / 100).toFixed(2),
    });
    return result;
  }

  function editPlan(plan) {
    setEditingPlanId(plan.id);
    setPlanForm({
      name: plan.name,
      type: plan.type,
      price: (plan.priceFen / 100).toFixed(2),
      durationDays: plan.type === 'subscription' ? String(plan.durationSeconds / 86400) : '30',
      httpsQuota: String(plan.httpsQuota),
      wssDurationMinutes: String(plan.wssDurationSeconds === -1 ? -1 : plan.wssDurationSeconds / 60),
      purchaseLimit: String(plan.purchaseLimit),
      httpsOverage: (plan.httpsOverageFen / 100).toFixed(2),
      wssOverage: (plan.wssOverageFen / 100).toFixed(2),
    });
  }

  async function savePlan(event) {
    event.preventDefault();
    const body = {
      ...planForm,
      durationDays: Number(planForm.durationDays),
      httpsQuota: Number(planForm.httpsQuota),
      wssDurationMinutes: Number(planForm.wssDurationMinutes),
      purchaseLimit: Number(planForm.purchaseLimit),
    };
    await runAction(async () => {
      await api(editingPlanId ? `/api/admin/plans/${editingPlanId}` : '/api/admin/plans', {
        method: editingPlanId ? 'PUT' : 'POST',
        body: JSON.stringify(body),
      });
      await refreshPlans();
      setEditingPlanId(null);
      setPlanForm(emptyPlan);
    }, editingPlanId ? '套餐已更新。' : '套餐已创建。');
  }

  async function deletePlan(plan) {
    if (!window.confirm(`确定移除套餐“${plan.name}”吗？正在使用此套餐的用户将回到默认按量计费。`)) return;
    await runAction(async () => {
      await api(`/api/admin/plans/${plan.id}`, { method: 'DELETE' });
      await refreshPlans();
      if (canReadUsers) setUsers(await api('/api/admin/users').then((result) => result.users));
      if (editingPlanId === plan.id) {
        setEditingPlanId(null);
        setPlanForm(emptyPlan);
      }
    }, '套餐已移除。');
  }

  async function saveBillingRates(event) {
    event.preventDefault();
    await runAction(async () => {
      await api('/api/admin/billing-rates', {
        method: 'PUT',
        body: JSON.stringify(billingRates),
      });
      await refreshPlans();
    }, '默认按量计费价格已保存。');
  }

  async function purchasePlan(plan) {
    if (!window.confirm(`确定以 ${formatMoney(plan.priceFen)} 购买“${plan.name}”吗？这会替换当前套餐。`)) return;
    await runAction(async () => {
      await api(`/api/user/plans/${plan.id}/purchase`, { method: 'POST' });
      await refreshPlans();
      setProfile(await api('/api/user/profile'));
    }, '套餐已购买并生效。');
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
  const visiblePlans = plans
    ?.filter((plan) => plan.type === planType)
    .sort((first, second) => {
      if (planType === 'subscription') {
        const firstLimit = first.purchaseLimit === -1 ? Number.POSITIVE_INFINITY : first.purchaseLimit;
        const secondLimit = second.purchaseLimit === -1 ? Number.POSITIVE_INFINITY : second.purchaseLimit;
        return firstLimit - secondLimit || Number(first.priceFen) - Number(second.priceFen);
      }
      return Number(first.priceFen) - Number(second.priceFen);
    });

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

          {activeSection === 'plan' && (canReadPlan || canManagePlans) && (
            <>
              <div className="page-heading">
                <div><p className="page-eyebrow">BILLING PLAN</p><h1>套餐</h1><p className="page-subtitle">购买订阅套餐或资源包；超出额度后按默认计费价格扣除余额。</p></div>
              </div>
              {canReadPlan && (
                <div className="account-summary plan-summary content-card">
                  <div><span>当前套餐</span><strong>{profile?.planName && (!profile.planExpiresAt || profile.planExpiresAt > Date.now()) ? profile.planName : '默认按量计费'}</strong></div>
                  <div><span>余额</span><strong>{profile ? formatMoney(profile.balanceFen) : '--'}</strong></div>
                  <div><span>到期时间</span><strong>{profile?.planExpiresAt ? new Date(profile.planExpiresAt).toLocaleString() : '无'}</strong></div>
                </div>
              )}
              {(canReadPlan || canManagePlans) && (
                <>
                  <div className="plan-tabs" role="tablist" aria-label="套餐类型">
                    <button
                      className={`plan-tab${planType === 'subscription' ? ' active' : ''}`}
                      id="subscription-plans-tab"
                      type="button"
                      role="tab"
                      aria-selected={planType === 'subscription'}
                      aria-controls="plan-list"
                      onClick={() => setPlanType('subscription')}
                    >订阅套餐</button>
                    <button
                      className={`plan-tab${planType === 'resource' ? ' active' : ''}`}
                      id="resource-plans-tab"
                      type="button"
                      role="tab"
                      aria-selected={planType === 'resource'}
                      aria-controls="plan-list"
                      onClick={() => setPlanType('resource')}
                    >资源包套餐</button>
                  </div>
                  <div className="plan-grid" id="plan-list" role="tabpanel" aria-labelledby={`${planType}-plans-tab`}>
                    {visiblePlans?.map((plan) => (
                      <article className={`content-card plan-card${hasActivePlan(profile, plan.id) ? ' selected' : ''}`} key={plan.id}>
                        <div className="plan-card-heading">
                          <div><span className="plan-indicator" /><div><h2>{plan.name}</h2><p>{plan.type === 'subscription' ? `订阅 · ${plan.durationSeconds / 86400} 天` : '资源包 · 长期有效'}</p></div></div>
                          <span className="plan-price">{formatMoney(plan.priceFen)}</span>
                        </div>
                        <p className="plan-description">
                          HTTPS {plan.httpsQuota === -1 ? '不限' : `${plan.httpsQuota} 次`} · WSS {plan.wssDurationSeconds === -1 ? '不限时长' : `${plan.wssDurationSeconds / 60} 分钟`}
                        </p>
                        {plan.type === 'subscription' && (
                          <>
                            <p className="plan-description">每人限购：{plan.purchaseLimit === -1 ? '不限' : `${plan.purchaseLimit} 次`}</p>
                            <p className="plan-description">套餐外：HTTPS {formatMoney(plan.httpsOverageFen)} / 次 · WSS {formatMoney(plan.wssOverageFen)} / 分钟</p>
                          </>
                        )}
                        {canReadPlan && (hasActivePlan(profile, plan.id)
                          ? <span className="plan-default-tag">当前套餐</span>
                          : <button className="primary-button plan-buy-button" type="button" onClick={() => purchasePlan(plan)} disabled={busy}>购买</button>)}
                        {canManagePlans && (
                          <div className="row-actions plan-admin-actions">
                            <button className="text-button" type="button" onClick={() => editPlan(plan)}>编辑</button>
                            <button className="text-button remove-button" type="button" onClick={() => deletePlan(plan)} disabled={busy}>移除</button>
                          </div>
                        )}
                      </article>
                    ))}
                    {plans === null && <p className="loading-note">正在读取套餐…</p>}
                    {plans && !plans.length && <p className="loading-note">暂无可用套餐。</p>}
                    {plans?.length > 0 && visiblePlans?.length === 0 && <p className="loading-note">暂无{planType === 'subscription' ? '订阅套餐' : '资源包套餐'}。</p>}
                  </div>
                </>
              )}
              {canManagePlans && (
                <>
                  <form className="content-card create-form" onSubmit={saveBillingRates}>
                    <div className="card-heading"><div><h2>默认按量计费价格</h2><p>未购买套餐或资源包额度耗尽时使用；金额按 HTTPS 每次和 WSS 每分钟计。</p></div></div>
                    <div className="form-grid">
                      <label>HTTPS（元/次）<input type="number" min="0" step="0.01" value={billingRates.httpsPrice} onChange={(event) => setBillingRates((current) => ({ ...current, httpsPrice: event.target.value }))} required /></label>
                      <label>WSS（元/分钟）<input type="number" min="0" step="0.01" value={billingRates.wssPrice} onChange={(event) => setBillingRates((current) => ({ ...current, wssPrice: event.target.value }))} required /></label>
                    </div>
                    <button className="primary-button" type="submit" disabled={busy}>保存默认价格</button>
                  </form>
                  <form className="content-card create-form plan-editor" onSubmit={savePlan}>
                    <div className="card-heading"><div><h2>{editingPlanId ? '编辑套餐' : '添加套餐'}</h2><p>HTTPS 次数、WSS 时长和每人限购次数 -1 表示不限制；订阅时间按天填写，WSS 时长按分钟填写。</p></div></div>
                    <div className="form-grid">
                      <label>套餐名称<input value={planForm.name} onChange={(event) => setPlanForm((current) => ({ ...current, name: event.target.value }))} maxLength={64} required /></label>
                      <label>类型<select value={planForm.type} onChange={(event) => setPlanForm((current) => ({ ...current, type: event.target.value }))}><option value="subscription">订阅</option><option value="resource">资源包</option></select></label>
                      <label>价格（元）<input type="number" min="0" step="0.01" value={planForm.price} onChange={(event) => setPlanForm((current) => ({ ...current, price: event.target.value }))} required /></label>
                      {planForm.type === 'subscription' && <label>持续时间（天）<input type="number" min="1" max="36500" step="1" value={planForm.durationDays} onChange={(event) => setPlanForm((current) => ({ ...current, durationDays: event.target.value }))} required /></label>}
                      {planForm.type === 'subscription' && <label>每人限购次数（-1 不限）<input type="number" min="-1" step="1" value={planForm.purchaseLimit} onChange={(event) => setPlanForm((current) => ({ ...current, purchaseLimit: event.target.value }))} required /></label>}
                      <label>HTTPS 代理次数<input type="number" min="-1" step="1" value={planForm.httpsQuota} onChange={(event) => setPlanForm((current) => ({ ...current, httpsQuota: event.target.value }))} required /></label>
                      <label>WSS 时长（分钟）<input type="number" min="-1" step="1" value={planForm.wssDurationMinutes} onChange={(event) => setPlanForm((current) => ({ ...current, wssDurationMinutes: event.target.value }))} required /></label>
                      {planForm.type === 'subscription' && <>
                        <label>套餐外 HTTPS（元/次）<input type="number" min="0" step="0.01" value={planForm.httpsOverage} onChange={(event) => setPlanForm((current) => ({ ...current, httpsOverage: event.target.value }))} required /></label>
                        <label>套餐外 WSS（元/分钟）<input type="number" min="0" step="0.01" value={planForm.wssOverage} onChange={(event) => setPlanForm((current) => ({ ...current, wssOverage: event.target.value }))} required /></label>
                      </>}
                    </div>
                    <div className="plan-form-actions">
                      <button className="primary-button" type="submit" disabled={busy}>{editingPlanId ? '保存套餐' : '创建套餐'}</button>
                      {editingPlanId && <button className="modal-cancel" type="button" onClick={() => { setEditingPlanId(null); setPlanForm(emptyPlan); }} disabled={busy}>取消编辑</button>}
                    </div>
                  </form>
                </>
              )}
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
              {canChangeEditingUserPermissions && (
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
                    <thead><tr><th>用户</th><th>权限</th><th>套餐 / 余额</th><th>数据</th>{canModifyUsers && <th>操作</th>}</tr></thead>
                    <tbody>
                      {users?.map((row) => (
                        <tr key={row.id}>
                          <td><div className="table-user"><span className="table-avatar">{row.username.slice(0, 1).toUpperCase()}</span><span>{row.username}<small>ID {row.id}{row.isBanned ? ' · 已封禁' : ''}</small></span></div></td>
                          <td><PermissionTags permissions={row.permissions} /></td>
                          <td><span>{row.planName || '默认按量计费'}</span><small className="table-secondary">{formatMoney(row.balanceFen)}</small></td>
                          <td><code className="data-preview">{JSON.stringify(row.data)}</code></td>
                          {canModifyUsers && (
                            <td>
                              <div className="row-actions">
                                <button className="text-button" type="button" onClick={() => openUserEditor(row)}>修改</button>
                              </div>
                            </td>
                          )}
                        </tr>
                      ))}
                      {users === null && <tr><td className="empty-row" colSpan={canModifyUsers ? 5 : 4}>--</td></tr>}
                      {users && !users.length && <tr><td className="empty-row" colSpan={canModifyUsers ? 5 : 4}>暂无用户。</td></tr>}
                    </tbody>
                  </table>
                </div>
              </div>
              {editingUser && userDraft && (
                <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
                  if (event.target === event.currentTarget && !busy) {
                    setEditingUser(null);
                    setUserDraft(null);
                  }
                }}>
                  <form className="user-edit-modal" role="dialog" aria-modal="true" aria-busy={busy} aria-labelledby="user-edit-title" onSubmit={saveUserChanges}>
                    <div className="modal-heading">
                      <div><p className="page-eyebrow">USER SETTINGS</p><h2 id="user-edit-title">修改用户</h2></div>
                      <button className="modal-close" type="button" aria-label="关闭" onClick={() => { setEditingUser(null); setUserDraft(null); }} disabled={busy}>×</button>
                    </div>
                    <div className="modal-user-summary">
                      <strong>{editingUser.username}</strong>
                      <span>当前权限</span>
                      <PermissionTags permissions={editingUser.permissions} />
                    </div>
                    {canChangePermissions && (
                      <fieldset className="permission-picker modal-permissions">
                        <legend>修改权限</legend>
                        {permissionOptions.map(([permission, label]) => (
                          <label key={permission}><input
                            type="checkbox"
                            checked={userDraft.permissions.includes(permission)}
                            onChange={(event) => setUserDraft((current) => ({
                              ...current,
                              permissions: event.target.checked
                                ? [...current.permissions, permission]
                                : current.permissions.filter((item) => item !== permission),
                            }))}
                          />{label}</label>
                        ))}
                      </fieldset>
                    )}
                    <div className="modal-fields">
                      {canChangeEditingUserPassword && <label>设置新密码<input type="password" value={userDraft.password} onChange={(event) => setUserDraft((current) => ({ ...current, password: event.target.value }))} placeholder="留空表示不修改" /></label>}
                      {canBanUsers && <label className="modal-checkbox"><input type="checkbox" checked={userDraft.isBanned} onChange={(event) => setUserDraft((current) => ({ ...current, isBanned: event.target.checked }))} />封禁此用户</label>}
                      {canChangeUserPlan && <label>用户套餐<select value={userDraft.planId} onChange={(event) => setUserDraft((current) => ({ ...current, planId: event.target.value }))}><option value="">默认按量计费</option>{plans?.map((plan) => <option value={plan.id} key={plan.id}>{plan.name}（{plan.type === 'subscription' ? '订阅' : '资源包'}）</option>)}</select></label>}
                      {canChangeBalance && <>
                        <label>设置余额（元）<input type="number" min="0" step="0.01" value={userDraft.balance} onChange={(event) => setUserDraft((current) => ({ ...current, balance: event.target.value }))} required /></label>
                        <label>增加余额（元）<input type="number" min="0" step="0.01" value={userDraft.balanceAdd} onChange={(event) => setUserDraft((current) => ({ ...current, balanceAdd: event.target.value }))} required /></label>
                      </>}
                    </div>
                    <div className="modal-actions">
                      <button className="modal-cancel" type="button" onClick={() => { setEditingUser(null); setUserDraft(null); }} disabled={busy}>不保存</button>
                      <button className="modal-save" type="submit" disabled={busy}>保存</button>
                    </div>
                    {busy && <div className="modal-saving-overlay" role="status">正在保存...</div>}
                  </form>
                </div>
              )}
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
                    <thead><tr><th>账号 UUID</th><th>名称</th><th>用户标识</th><th>状态</th><th>信息</th><th>凭据</th>{canEditPool && <th>操作</th>}</tr></thead>
                    <tbody>
                      {accounts?.map((account) => (
                        <tr key={account.uuid}>
                          <td><code className="uuid-value">{account.uuid}</code></td>
                          <td>{account.name || <span className="empty-note">—</span>}</td>
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
                      {accounts === null && <tr><td className="empty-row" colSpan={canEditPool ? 7 : 6}>--</td></tr>}
                      {accounts && !accounts.length && <tr><td className="empty-row" colSpan={canEditPool ? 7 : 6}>号池暂时没有账号。</td></tr>}
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
