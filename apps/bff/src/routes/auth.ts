import { Hono } from 'hono';
import crypto from 'node:crypto';
import { config } from '../config.js';

export const authRoutes = new Hono();

/**
 * 知乎 OAuth 接入。
 *
 * 官方口径（黑客松 FAQ）：拿到 App ID / App Key、配置回调地址后，把项目交给 Agent 即可完成接入。
 * 流程：/start 302 到知乎授权页 → 知乎回调 /callback?code=... → 换 access_token → 取用户信息 →
 * 写 httpOnly 会话 cookie → 跳回应用。前端 /api/auth/me 读登录态。
 *
 * 三个要点：
 *  1. `redirect_uri` 必须与开放平台里配置的**完全一致**（协议、域名、参数都算）→ 所以从环境变量读，不拼。
 *  2. 用 `state` 防 CSRF：随机串存 cookie，回调时比对。
 *  3. 端点做成可配置（OAUTH_TOKEN_URL / OAUTH_ME_URL），知乎若调整地址不必改代码。
 */

const SESSION_COOKIE = 'zhimian_session';
const STATE_COOKIE = 'zhimian_oauth_state';
const SESSION_TTL_SEC = 7 * 24 * 3600;

function configured(): boolean {
  return Boolean(config.oauthAppId && config.oauthAppKey && config.oauthRedirectUri);
}

/** 会话签名：HMAC(secret, payload)，secret 没有就用 App Key 派生 */
function sessionSecret(): string {
  return config.oauthAppKey || config.oauthAppSecret || 'zhimian-local-dev';
}

function sign(payload: string): string {
  return crypto.createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
}

interface SessionUser {
  id: string;
  name: string;
  avatar?: string;
}

function makeSession(user: SessionUser): string {
  const body = Buffer.from(JSON.stringify({ ...user, exp: Date.now() + SESSION_TTL_SEC * 1000 })).toString('base64url');
  return `${body}.${sign(body)}`;
}

function readSession(raw: string | undefined): SessionUser | null {
  if (!raw) return null;
  const dot = raw.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = raw.slice(0, dot);
  const mac = raw.slice(dot + 1);
  const expected = sign(body);
  // 定长比较，避免时序侧信道
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as {
      id: string;
      name: string;
      avatar?: string;
      exp: number;
    };
    if (!data.exp || data.exp < Date.now()) return null;
    return { id: data.id, name: data.name, avatar: data.avatar };
  } catch {
    return null;
  }
}

/** 启动授权：302 到知乎授权页，并带上防 CSRF 的 state */
authRoutes.get('/zhihu/start', (c) => {
  if (!configured()) {
    return c.json(
      { error: { code: 'OAUTH_NOT_CONFIGURED', message: '知乎 OAuth 凭据尚未配置（免登录核心流程不受影响）' } },
      501
    );
  }
  const state = crypto.randomBytes(16).toString('hex');
  c.header('Set-Cookie', `${STATE_COOKIE}=${state}; Path=/; Max-Age=600; SameSite=Lax; HttpOnly`);
  const url = new URL('https://www.zhihu.com/oauth/authorize');
  url.searchParams.set('client_id', config.oauthAppId);
  url.searchParams.set('redirect_uri', config.oauthRedirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', state);
  return c.redirect(url.toString(), 302);
});

/** 回调：换 token → 取用户 → 写会话 → 跳回应用首页 */
authRoutes.get('/zhihu/callback', async (c) => {
  if (!configured()) {
    return c.json({ error: { code: 'OAUTH_NOT_CONFIGURED', message: '知乎 OAuth 凭据尚未配置' } }, 501);
  }
  const code = c.req.query('code');
  const state = c.req.query('state');
  const expectedState = c.req.header('Cookie')?.match(new RegExp(`${STATE_COOKIE}=([a-f0-9]+)`))?.[1];
  if (!code) return c.text('缺少授权码 code', 400);
  if (!state || !expectedState || state !== expectedState) {
    return c.text('OAuth state 校验失败（可能是会话过期或链接被篡改），请重新发起登录', 400);
  }

  try {
    // 1) 用授权码换 access_token
    const tokenRes = await fetch(config.oauthTokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: config.oauthAppId,
        client_secret: config.oauthAppKey,
        code,
        redirect_uri: config.oauthRedirectUri,
      }).toString(),
    });
    const tokenData = (await tokenRes.json()) as { access_token?: string; error?: string; error_description?: string };
    if (!tokenRes.ok || !tokenData.access_token) {
      return c.text(`OAuth 换取 token 失败：${tokenData.error_description || tokenData.error || tokenRes.status}`, 502);
    }

    // 2) 取用户信息（拿不到昵称也不阻断登录）
    let user: SessionUser = { id: 'zhihu-user', name: '知乎用户' };
    try {
      const meRes = await fetch(config.oauthMeUrl, {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      if (meRes.ok) {
        const me = (await meRes.json()) as { id?: string; name?: string; avatar_url?: string };
        user = { id: String(me.id ?? 'zhihu-user'), name: me.name || '知乎用户', avatar: me.avatar_url };
      }
    } catch {
      /* 用户信息取不到不影响登录 */
    }

    // 3) 写会话 cookie（httpOnly，前端读不到也改不了）
    c.header('Set-Cookie', `${SESSION_COOKIE}=${makeSession(user)}; Path=/; Max-Age=${SESSION_TTL_SEC}; SameSite=Lax; HttpOnly`);
    c.header('Set-Cookie', `${STATE_COOKIE}=; Path=/; Max-Age=0`);
    return c.redirect('/', 302);
  } catch (err) {
    return c.text(`OAuth 回调失败：${err instanceof Error ? err.message : '未知错误'}`, 502);
  }
});

/** 当前登录态（前端顶栏显示） */
authRoutes.get('/me', (c) => {
  if (!configured()) {
    return c.json({ error: { code: 'OAUTH_NOT_CONFIGURED', message: '知乎 OAuth 凭据尚未配置' } }, 501);
  }
  const user = readSession(c.req.header('Cookie')?.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`))?.[1]);
  if (!user) return c.json({ error: { code: 'UNAUTHENTICATED', message: '未登录' } }, 401);
  return c.json({ user });
});

/** 退出登录 */
authRoutes.get('/logout', (c) => {
  c.header('Set-Cookie', `${SESSION_COOKIE}=; Path=/; Max-Age=0`);
  return c.redirect('/', 302);
});
