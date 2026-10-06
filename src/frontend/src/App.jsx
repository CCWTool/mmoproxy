import { useEffect, useState } from 'react';
import Dashboard from './Dashboard.jsx';

function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <svg viewBox="0 0 32 32" fill="none">
        <path d="M7 23V11.5h4v1.7c.8-1.3 2-2 3.6-2 1.8 0 3 .8 3.6 2.2.9-1.5 2.2-2.2 4-2.2 2.8 0 4.5 1.8 4.5 5V23h-4.2v-6.1c0-1.5-.6-2.3-1.8-2.3-1.3 0-2 .9-2 2.5V23h-4.2v-6.1c0-1.5-.6-2.3-1.8-2.3-1.3 0-2 .9-2 2.5V23H7Z" fill="currentColor" />
      </svg>
    </span>
  );
}

function UserIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <circle cx="10" cy="6.2" r="3.2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M3.8 16.2c.6-2.8 2.8-4.3 6.2-4.3s5.6 1.5 6.2 4.3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <rect x="4" y="8.5" width="12" height="8.3" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M6.7 8.5V6a3.3 3.3 0 0 1 6.6 0v2.5M10 11.8v1.8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export default function App() {
  const [authStatus, setAuthStatus] = useState('checking');
  const [currentUser, setCurrentUser] = useState(null);
  const [isRegistering, setIsRegistering] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [registrationNotice, setRegistrationNotice] = useState('');

  useEffect(() => {
    let active = true;

    fetch('/api/auth/session', { credentials: 'same-origin' })
      .then(async (response) => {
        if (!response.ok) throw new Error('无法连接到登录服务，请稍后重试。');
        return response.json();
      })
      .then(({ authenticated, user }) => {
        if (active) {
          setCurrentUser(user);
          setAuthStatus(authenticated ? 'authenticated' : 'unauthenticated');
        }
      })
      .catch((error) => {
        if (active) {
          setAuthStatus('unauthenticated');
          setErrorMessage(error.message);
        }
      });

    return () => {
      active = false;
    };
  }, []);

  async function handleSubmit(event) {
    event.preventDefault();
    if (isSubmitting) return;

    if (isRegistering && password !== confirmPassword) {
      setErrorMessage('两次输入的密码不一致，请检查后重试。');
      return;
    }

    setIsSubmitting(true);
    setErrorMessage('');

    try {
      const response = await fetch(isRegistering ? '/api/web/register' : '/api/web/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ username: username.trim(), password }),
      });
      const result = await response.json();

      if (!response.ok) {
        setErrorMessage(
          response.status === 401
            ? '用户名或密码不正确，请重试。'
            : result.message || (isRegistering ? '注册失败，请稍后重试。' : '登录失败，请稍后重试。'),
        );
        return;
      }

      if (isRegistering) {
        setRegistrationNotice('账号创建成功，请使用新账号登录。');
        setPassword('');
        setConfirmPassword('');
        setIsRegistering(false);
      } else {
        const sessionResponse = await fetch('/api/auth/session', { credentials: 'same-origin' });
        const session = await sessionResponse.json();
        if (!sessionResponse.ok || !session.authenticated) throw new Error('登录成功，但无法读取用户信息。');
        setCurrentUser(session.user);
        setAuthStatus('authenticated');
      }
    } catch {
      setErrorMessage('无法连接到登录服务，请检查网络后重试。');
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleLogout() {
    const response = await fetch('/api/web/logout', { method: 'POST', credentials: 'same-origin' });
    if (!response.ok) throw new Error('退出登录失败，请重试。');
    setCurrentUser(null);
    setAuthStatus('unauthenticated');
  }

  if (authStatus === 'checking') {
    return <main className="blank-screen" aria-label={authStatus === 'checking' ? '正在检查登录状态' : '已登录'} />;
  }

  if (authStatus === 'authenticated' && currentUser) {
    return <Dashboard user={currentUser} onLogout={handleLogout} />;
  }

  return (
    <main className="login-page">
      <div className="ambient ambient-one" aria-hidden="true" />
      <div className="ambient ambient-two" aria-hidden="true" />

      <header className="site-header">
        <a className="brand" href="/" aria-label="mmoproxy">
          <BrandMark />
          <span className="brand-name">mmoproxy</span>
        </a>
        <span className="header-note"><span className="header-dot" />{isRegistering ? '创建账号' : '安全登录'}</span>
      </header>

      <section className="login-layout" aria-labelledby="login-title">
        <div className="welcome-panel">
          <div className="welcome-copy">
            <p className="overline">YOUR ACCOUNT SPACE</p>
            <h1>{isRegistering ? '开始使用' : '欢迎回来'}<span className="title-period">.</span></h1>
            <p className="welcome-description">
              {isRegistering ? '创建账号，开启你的 MMO 号池。' : '登录以继续使用你的 MMO 号池。'}
            </p>
          </div>
          <div className="orbit-art" aria-hidden="true">
            <div className="orbit orbit-outer" />
            <div className="orbit orbit-inner" />
            <div className="orbit-core"><BrandMark /></div>
            <span className="orbit-node node-one" />
            <span className="orbit-node node-two" />
            <span className="orbit-node node-three" />
          </div>
          <p className="panel-caption">ONE SPACE FOR YOUR MMO ACCOUNTS</p>
        </div>

        <div className="form-panel">
          <div className="form-heading">
            <p className="form-kicker">{isRegistering ? 'CREATE ACCOUNT' : 'ACCOUNT ACCESS'}</p>
            <h2 id="login-title">{isRegistering ? '创建账号' : '登录账号'}</h2>
            <p>{isRegistering ? '填写信息，创建你的 mmoproxy 账号。' : '请输入你的用户名和密码。'}</p>
          </div>

          <form className="login-form" onSubmit={handleSubmit}>
            {registrationNotice && !isRegistering && (
              <p className="form-success" role="status">{registrationNotice}</p>
            )}
            <label className="field-label" htmlFor="username">用户名</label>
            <div className="input-wrap">
              <span className="input-icon"><UserIcon /></span>
              <input
                autoComplete="username"
                autoCapitalize="none"
                id="username"
                name="username"
                placeholder="输入用户名"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                required
                disabled={isSubmitting}
              />
            </div>

            <label className="field-label password-field-label" htmlFor="password">密码</label>
            <div className="input-wrap">
              <span className="input-icon"><LockIcon /></span>
              <input
                autoComplete={isRegistering ? 'new-password' : 'current-password'}
                id="password"
                name="password"
                placeholder={isRegistering ? '设置密码' : '输入密码'}
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
                disabled={isSubmitting}
              />
              <button
                className="password-toggle"
                type="button"
                onClick={() => setShowPassword((visible) => !visible)}
                aria-label={showPassword ? '隐藏密码' : '显示密码'}
                aria-pressed={showPassword}
              >
                {showPassword ? '隐藏' : '显示'}
              </button>
            </div>

            {isRegistering && (
              <>
                <label className="field-label password-field-label" htmlFor="confirm-password">确认密码</label>
                <div className="input-wrap">
                  <span className="input-icon"><LockIcon /></span>
                  <input
                    autoComplete="new-password"
                    id="confirm-password"
                    name="confirm-password"
                    placeholder="再次输入密码"
                    type={showPassword ? 'text' : 'password'}
                    value={confirmPassword}
                    onChange={(event) => setConfirmPassword(event.target.value)}
                    required
                    disabled={isSubmitting}
                  />
                </div>
              </>
            )}

            {errorMessage && <p className="form-error" role="alert">{errorMessage}</p>}

            <button
              className="submit-button"
              type="submit"
              disabled={isSubmitting || !username.trim() || !password || (isRegistering && !confirmPassword)}
            >
              <span>
                {isSubmitting
                  ? (isRegistering ? '正在创建账号' : '正在登录')
                  : (isRegistering ? '创建账号' : '登录')}
              </span>
              {!isSubmitting && <span className="button-arrow" aria-hidden="true">→</span>}
              {isSubmitting && <span className="button-spinner" aria-hidden="true" />}
            </button>
          </form>
          <p className="form-footnote"><span className="footnote-lock"><LockIcon /></span>你的登录信息会被安全加密传输</p>
          <p className="auth-switch">
            {isRegistering ? '已经有账号？' : '还没有账号？'}
            <button
              type="button"
              onClick={() => {
                setIsRegistering((registering) => !registering);
                setErrorMessage('');
                setRegistrationNotice('');
                setPassword('');
                setConfirmPassword('');
              }}
            >
              {isRegistering ? '返回登录' : '立即注册'}
            </button>
          </p>
        </div>
      </section>

      <footer className="site-footer">
        <span>© {new Date().getFullYear()} mmoproxy</span>
        <span>CCW MMO ACCOUNT POOL</span>
      </footer>
    </main>
  );
}
