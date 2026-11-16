import { Hono } from 'hono';
import { config } from '../config.js';

export const authRoutes = new Hono();

// §16 Q3：12.05 拿到 OAuth App ID / Key 前返回 501，前端自动隐藏入口
authRoutes.get('/zhihu/start', (c) => {
  if (!config.oauthAppId || !config.oauthAppKey) {
    return c.json(
      { error: { code: 'OAUTH_NOT_CONFIGURED', message: '知乎 OAuth 凭据尚未配置（免登录核心流程不受影响）' } },
      501
    );
  }
  const authUrl = `https://www.zhihu.com/oauth/authorize?client_id=${encodeURIComponent(config.oauthAppId)}&redirect_uri=${encodeURIComponent(config.oauthRedirectUri)}&response_type=code`;
  return c.redirect(authUrl, 302);
});
