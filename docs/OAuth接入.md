# 知乎 OAuth 接入（可选加分项）

> 官方 FAQ：**「在黑客松项目中拿到 App ID 和 OAuth App Key、配置回调地址，直接把现有项目交给 Agent，让它帮你完成接入。」**
> 已实现（后端 `apps/bff/src/routes/auth.ts` + 前端顶栏登录区），**只差凭据**。

---

## 一、拿凭据（12.05 作品提交通道开放后，官方会发 App ID / App Key）

1. 在黑客松项目里申请 **OAuth App ID / App Key**（或用开发者平台的 App）。
2. 在开放平台配置 **回调地址（redirect_uri）**，例如：
   ```
   https://你的域名/api/auth/zhihu/callback
   ```
   ⚠️ 必须与下面环境变量里的 `OAUTH_REDIRECT_URI` **逐字一致**（协议、域名、路径、参数都算）。
3. **知乎账号要有实名制（手机号）+ 实名认证**，否则授权会失败（官方明确说明）。

---

## 二、填环境变量（部署平台里）

```
OAUTH_APP_ID=你的AppID
OAUTH_APP_KEY=你的AppKey
OAUTH_APP_SECRET=（如果平台给的是 secret，一并填上）
OAUTH_REDIRECT_URI=https://你的域名/api/auth/zhihu/callback
```

可选（端点做成可配置，知乎若调整地址不用改代码）：
```
OAUTH_TOKEN_URL=https://www.zhihu.com/api/v4/oauth/token
OAUTH_ME_URL=https://api.zhihu.com/v4/me
```

---

## 三、已经实现的行为

| 接口 | 行为 |
|---|---|
| `GET /api/auth/zhihu/start` | 302 到知乎授权页，带防 CSRF 的 `state`（存 cookie，10 分钟有效） |
| `GET /api/auth/zhihu/callback?code=..&state=..` | 校验 state → 用授权码换 access_token → 取用户信息 → 写 **httpOnly 会话 cookie**（HMAC 签名，7 天）→ 跳回首页 |
| `GET /api/auth/me` | 返回 `{user:{id,name,avatar}}`；未登录 401；**服务端没配凭据 501** |
| `GET /api/auth/logout` | 清会话 cookie 并跳回首页 |

前端：
- 顶栏右侧出现「用知乎账号登录」；登录后显示「知乎 · 昵称」+「退出」。
- **服务端没配 OAuth 凭据时，登录入口整个隐藏**（不会出现点了没反应的按钮）。
- 免登录也能完整使用所有功能 —— OAuth 只是**身份标记**，不是使用门槛。

---

## 四、本地自测

```bash
# 1) 填好 .env 后重启
node scripts/dev/restart.mjs 8787

# 2) 没配凭据时：入口应隐藏，接口返回 501
curl -s http://127.0.0.1:8787/api/auth/me

# 3) 配好凭据后：访问 /api/auth/zhihu/start 会跳到知乎授权页
#    授权完成后应跳回首页，顶栏显示昵称
```

---

## 五、注意事项

- **`redirect_uri` 不一致是最常见的失败原因**，先把它逐字对齐再排查别的。
- 会话 cookie 是 `HttpOnly + SameSite=Lax`，前端读不到也改不了（防 XSS 窃取）。
- 我们的数据本来就在浏览器本地，**OAuth 不会把任何简历/录音传到知乎**，只是"你是谁"的标记。
- 提报表单若勾选了"有登录功能"，需提供测试账号密码 —— 我们**没有登录墙**，建议在说明里写清"无需登录即可体验"，避免评委以为登录不了。

---

## 六、给评委的两种打开方式（都写进提报表单）

| 方式 | 地址 | 说明 |
|---|---|---|
| 免登录（推荐主推） | `https://你的域名/?k=<分享口令>` | 打开即用，功能完整 |
| 带知乎登录 | `https://你的域名/?k=<分享口令>` 后点顶栏「用知乎账号登录」 | 用于展示与知乎生态的衔接 |
