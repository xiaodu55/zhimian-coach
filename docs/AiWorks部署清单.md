# AiWorks 部署清单（路线 A · 官方推荐）

> 官方 FAQ：**「前端 + Node 后端、不含数据库写入的全栈项目 → 可使用知乎 [AiWorks](https://www.zhihu.com/project-square) 提供的部署能力。」**
> 本项目正是这一类（服务端零落盘，数据全在浏览器 IndexedDB）。
>
> 目标：拿到一个**固定的 HTTPS 域名**，填进提报表单的「可运行体验链接（必交）」。

---

## 一、动手前 3 分钟检查

| # | 检查 | 怎么查 | 不通过怎么办 |
|---|---|---|---|
| 1 | 代码已推到远端 | `git log --oneline -1` 且 `git status` 干净 | 先 `git push` |
| 2 | 平台能拉到仓库 | 仓库是**公开**的最好；私有仓库需要平台侧授权 GitHub | 私有就授权；或镜像到 Gitee / 平台支持直接上传压缩包 |
| 3 | 远端地址 | `git remote -v` → `https://github.com/xiaodu55/zhimian-coach.git` | 需要换地址就改远端 |
| 4 | 锁文件与依赖一致 | `pnpm install --frozen-lockfile` 能过（已自检通过） | 跑 `pnpm install --lockfile-only` 后重试 |
| 5 | 知道要填哪些环境变量 | `node scripts/dev/print-env-for-deploy.mjs` | — |

> 仓库结构：**单容器、单端口**（BFF 同时托管静态站与 `/api`），同域无 CORS，录音也能直接用。

---

## 二、在 AiWorks 上建项目

1. 打开 <https://www.zhihu.com/project-square> → 用**参赛同一个知乎账号**登录 → 新建项目 → 选「全栈 / Node 后端」。
2. 填仓库地址 `https://github.com/xiaodu55/zhimian-coach.git`（私有仓库先授权）。
3. 分支选 `main`。
4. 部署形态二选一：

| 形态 | 怎么填 |
|---|---|
| **Dockerfile（推荐）** | 构建方式选 Dockerfile，仓库根目录已有 `Dockerfile`（多阶段、生产只跑 `dist`，同域托管静态站）。构建上下文 = 仓库根。 |
| **Node 构建** | 安装命令 `pnpm install --frozen-lockfile`（或 `npm ci`）→ 构建命令 `pnpm --filter @zhimian/bff build` → 启动命令 `npm start` |

5. **启动命令**：`npm start`
   （等价于 `node scripts/dev/start-prod.mjs`：若平台没跑构建，它会自己 `tsc` 编译后再启动。）
6. **端口**：`8787`（平台若注入 `PORT`，代码会自动读）。
7. **健康检查路径**：`/api/health`（返回 `ok:true` 即可判活）。
8. **环境变量**（照抄 `node scripts/dev/print-env-for-deploy.mjs` 的输出）：

```
LLM_BASE_URL=https://api.deepseek.com
LLM_API_KEY=…
LLM_MODEL=deepseek-v4-flash
ZHIHU_ACCESS_SECRET=…
PUBLIC_SHARE_TOKEN=<随机长串>      ← 公网必须设
PORT=8787
LLM_MAX_CONCURRENCY=3
CACHE_DIR=/data/.cache
CACHE_PERSIST=1
```

9. 绑定/生成 **HTTPS 域名**（平台一般自动给 `*.aiworks.*` 之类的域名）。
10. 部署完成后，用带口令的地址打开：
    `https://你的域名/?k=<PUBLIC_SHARE_TOKEN>`
    （前端会把 `?k=` 存进 sessionStorage，之后所有 `/api` 请求自动带 `x-share-token`。）

---

## 三、部署后自检（逐条点，别跳）

| # | 检查 | 期望 |
|---|---|---|
| 1 | 打开 `https://你的域名/` | 首屏 Hero + 题库卡片，**浏览器控制台无报错** |
| 2 | 打开 `https://你的域名/api/health` | `ok:true`、`bankSize:92`、`requiresToken:true` |
| 3 | 不带 `?k=` 访问 `/api/bank` | 401（说明鉴权生效，陌生人烧不了额度） |
| 4 | 带 `?k=` 访问 `/api/bank` | 200 + 题库 JSON |
| 5 | 首页点各方向 chip | 7 个方向都有题，不再有 0 题方向 |
| 6 | 陪练室点「开始录音」 | 能授权麦克风并出字幕（**必须 https**，非 localhost 下 `getUserMedia` 需要安全上下文） |
| 7 | 作答 → 提交 → 看复盘 | 出维度分（带 `/ 100 分` 刻度）+ 原话级诊断 |
| 8 | 题卡「看原答 ↗」 | 能打开知乎原文 |
| 9 | 刷新页面 | 录音/闪卡/复盘记录仍在（证明数据在浏览器，服务器无状态） |

**自动化版自检**（一条命令跑完上面大部分）：

```bash
node scripts/test/smoke.mjs --base https://你的域名/?k=你的口令
```

> 注意：`--base` 后面的 `?k=` 会被拼到路径上，如果平台对 query 敏感，改用
> `node scripts/test/smoke.mjs --base https://你的域名` 并先在浏览器里登录过一次（sessionStorage 复用不了，
> 所以更稳的做法是临时把 `PUBLIC_SHARE_TOKEN` 留空跑一次自检，**部署完成后再把口令打开**）。

---

## 四、如果要做知乎 OAuth（推荐加，但不影响提交）

1. 在知乎开放平台申请 **App ID / App Key / App Secret**（你的项目是"前端 + Node 后端"，服务端持有 secret）。
2. OAuth 的 `redirect_uri` 必须与部署域名**完全一致**（协议、域名、参数都算）。
3. 服务端已内置 OAuth 路由：`/api/auth/*`（`start` / `session`），前端在 `js/lib/` 有对应调用；
   拿到 App ID/Secret 后在平台环境变量里补上 `OAUTH_APP_ID` / `OAUTH_APP_KEY` / `OAUTH_REDIRECT_URI`。
4. **提报表单提示**：有登录功能须同时提供**测试账号密码**。我们目前**没有登录功能**，所以这条不适用；
   如果接了 OAuth 且有用户态，建议在提交说明里写清"评委可跳过登录直接体验"。

---

## 五、提报表单怎么填

| 表单项 | 填什么 |
|---|---|
| 可运行体验链接（必交） | `https://你的域名/?k=<PUBLIC_SHARE_TOKEN>`（把口令一起给评委，省得他们被 401 挡住；也可以单独在备注里给口令） |
| 产品说明计划书（必交） | 见 `README.md` 与 `开发日志.md`；建议附：闭环图（读懂→说清→被追问→查清楚）、隐私承诺（服务端零落盘）、技术要点（知乎语料溯源 / 确定性诊断规则 / 本地优先架构） |
| 代码仓库链接（可选加分） | `https://github.com/xiaodu55/zhimian-coach` |
| 项目演示视频（可选加分） | 3–5 分钟：首页 → 选方向 → 拆逻辑 → 陪练（**演示追问环节**，这是差异点）→ 复盘 → 弹药库 |

---

## 六、常见坑

| 现象 | 原因 | 处理 |
|---|---|---|
| 部署成功但页面 404 | 启动命令没起静态托管 | 必须用 `npm start`（同进程同时托管静态站与 API），别只跑 `node dist/index.js` 之外的命令 |
| 启动报 "没找到 dist/index.js" | 平台没跑构建 | `npm start` 会自动 `tsc`；或把构建命令填成 `pnpm --filter @zhimian/bff build` |
| `pnpm install` 报锁文件不一致 | 改了依赖没更新锁 | 本地 `pnpm install --lockfile-only` 后提交 `pnpm-lock.yaml` |
| 录音按钮无反应 | 不是 https / 非 localhost | 换平台给的 https 域名；`http://` 的 IP 直连不行 |
| 模型全变"规则模式" | 密钥没填或上游超时 | 看 `/api/health` 的 `llmConfigured`；容器里注意出网策略 |
| 知乎检索失败 | 当天配额用尽 | 两个桶独立，等次日；**别在演示期间跑题库跑批** |
| 陌生人把额度烧光 | 没设 `PUBLIC_SHARE_TOKEN` | 设上，用 `?k=` 分发 |
| 数据"丢了" | —— | 不会：用户数据全在浏览器 IndexedDB，服务端无状态，重启/换机器都不影响 |
