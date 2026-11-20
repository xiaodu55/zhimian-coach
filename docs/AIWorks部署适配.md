# AI Works / CloudBase 部署适配（官方 Skill 只读探测结果 + 修法）

> 官方提供的部署助手（AI Works Skill）实际是 **CloudBase 源码远端构建**的输入准备器。
> 下载地址（官网 AI Works 页面给出）：
> `https://zhstatic.zhihu.com/skill/application/d6c1-260923/zhihu-ai-works-deploy-helper_v1.2.0.zip`
>
> 本文件记录：**用官方探测器只读探测我们项目的结果** + 每个阻断项的修法。
> 探测命令（只读，不执行项目代码）：
> ```bash
> cd <helper>/scripts
> python - <<'PY'
> import sys, os, runpy
> sys.path.insert(0, os.getcwd())
> sys.argv = ['inspect_node_project.py', '--root', r'<项目根>', '--output', r'<报告.json>', '--backend-dir', 'apps/bff']
> runpy.run_path('inspect_node_project.py', run_name='__main__')
> PY
> ```

## 探测结论（2026-11-20，对当前仓库）

```
Status: blocked | ProjectType: backend-http | NodeVersion: 20
```

### 阻断项（error，必须清零才能生成交付物）

| 码 | 命中 | 官方修法 | 我们的修法 | 状态 |
|---|---|---|---|---|
| `E_BACKEND_ENTRY_UNRESOLVED` | 运行入口没解析出来 | 明确声明 Node 入口 | `apps/bff/package.json` 加 `"main": "dist/index.js"`，`start` 指向 `node dist/index.js` | 待做 |
| `E_DISK_WRITE_FORBIDDEN` | 运行时写磁盘：`fs.mkdir/mkdtemp/rm/writeFile` | 云函数文件系统只读，状态放内存 | 缓存改为**纯内存**（`CACHE_PERSIST` 默认关，不再写 `.cache/*.json`），删掉所有运行时写盘 | 待做 |
| `E_LOCAL_PERSISTENCE` | 存在 /tmp 之外的本地持久化 | 同上 | 同上（与上一条同源） | 待做 |
| `E_LOCKFILE_CONFLICT` | 同时有 `package-lock.json` 与 `pnpm-lock.yaml` | 交付包管理器固定 npm，保留 npm lockfile、移除其它包管理器的 lock/config | 仓库**统一到 npm**：删 `pnpm-lock.yaml`/`pnpm-workspace.yaml`，Dockerfile 改 `npm ci`，脚本改 `npm run --workspace` | 待做 |
| `E_USER_ENVIRONMENT_VARIABLE_UNSUPPORTED` | 运行时代码读了 `LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL` / `ZHIHU_ACCESS_SECRET` / `PUBLIC_SHARE_TOKEN` / `ASR_*` / `CACHE_*` / `LLM_MAX_CONCURRENCY` 等 | 运行时只允许注入 `PORT`/`HOST`/`HOSTNAME`/`NITRO_HOST`/`NITRO_PORT`（构建期另有 `AIWORKS_EVENT_TRACKING_TICKET`）。改写方式需**用户明确授权**：值会**明文进入源码与 ZIP**，任何拿到交付物的人都能读到 | **需要你授权**（见下方"需要你拍板的一件事"） | ⏸ 等授权 |

### 警告（warning，不阻断但建议处理）

| 码 | 含义 | 我们的处理 |
|---|---|---|
| `W_HEALTHCHECK_ABSENT` | 没识别到健康检查 | 我们有 `/api/health`，需在部署描述符里声明健康检查路径 |
| `W_NODE_VERSION_FALLBACK` | 推断不出 Node 大版本 | 根与 `apps/bff` 的 package.json 加 `"engines": {"node": "20"}`（CloudBase 映射到 `Nodejs20.19`，installDependency=true） |
| `W_PERSISTENT_PROCESS_REVIEW` | 长连接/常驻进程 | 我们的 SSE 流式需要复核；云函数有超时上限，准备**流式不可用时自动回落非流式**（前端已实现回落） |
| `W_SSE_LIMITS` | SSE 限制 | 同上：流式是增强项，非流式是保底，部署后先跑 `smoke.mjs` 确认 |
| `W_SENSITIVE_SOURCE_FILE` ×2 | `.env` / `.env.example` 需从交付包里排除 | 交付副本排除 `.env*`；运行期配置改由上面的授权方案提供 |

## 需要你拍板的一件事（官方明确要求先问）

官方 `E_USER_ENVIRONMENT_VARIABLE_UNSUPPORTED` 的修法原文：

> "Do not classify the variables as sensitive or non-sensitive. **Tell the user that replacing them with project-local literals will place their plaintext values in project source and the ZIP, readable by anyone with access. Ask for explicit authorization to rewrite every reported access.**"

也就是说：**云函数运行时拿不到我们自定义的环境变量**，官方路径要求把
`LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL` / `ZHIHU_ACCESS_SECRET` / `PUBLIC_SHARE_TOKEN` 等
**以明文写进交付源码与 ZIP**。任何拿到交付 ZIP / 部署包的人都能读到这些值。

三种可选处理（请选一个）：

| 方案 | 做法 | 风险 |
|---|---|---|
| **A（官方推荐）** | 授权后，我在**隔离交付副本**里把这些值固化为源码常量（仓库源码不受影响），交付包由我们生成后再上传 | 密钥出现在交付 ZIP 里；生成后**必须轮换密钥**（`LLM_API_KEY` / `ZHIHU_ACCESS_SECRET`） |
| B | 不部署到云函数，继续用 **cpolar 固定域名**（`https://375c1e65.r43.cpolar.top`） | 电脑必须开机；免费版带宽有限；但**密钥始终只在本机 .env**，零泄露面 |
| C | 部署到**自有的云主机**（阿里云/腾讯云轻量，¥24/月起），密钥放在服务器环境变量里 | 需要一台机器 + 公网 IP + 域名；密钥只在那台机器上；不受云函数变量限制 |

> 现实建议：**先 B 兜底（今天就有固定域名，零改动），同时按 A 走官方流程；12.05 提交时用 A 的平台域名，若 A 卡住就切回 B 的 cpolar 地址**。
> 无论选哪个，**提交前轮换一次 `LLM_API_KEY` 与 `ZHIHU_ACCESS_SECRET`**（公开过就必须换）。

## 修完之后的验证

```bash
# 1) 重跑官方探测器，确认 Status 不再是 blocked
# 2) 生成交付物并用官方校验脚本检查
python <helper>/scripts/validate_deploy_output.py ...
# 3) 部署后跑我们自己的远程自检（要 9/9）
node scripts/test/smoke.mjs --base https://<你的域名>
```


---

## 附：交付包"平台模拟"自检（上传前必做，已跑通）

平台会按 `backend.deploy.json` 的 CustomSteps 依次执行：

| 步 | 命令 |
|---|---|
| 1 安装构建依赖 | `npm ci` |
| 2 构建 | `node _tmp/materialize-event-tracking-ticket.cjs && npm run build --workspace @zhimian/bff && test -e apps/bff/dist` |
| 3 切换运行时依赖清单 | `node _tmp/prepare-backend-package.js`（**平台自己做，打包时不能提前跑**） |
| 4 安装生产依赖 | `npm install --omit=dev --ignore-scripts` |
| 5 验证 | `npm ls --omit=dev && test -f apps/bff/dist/index.js && test -x scf_bootstrap && test -f cloudbaserc.json` |
| 启动 | `scf_bootstrap` → `exec npm run start`（根 manifest 的 start） |

**本地完整复刻这 5 步 + 真启动一次**，本轮实测全部通过：
```
/api/health → ok:true, zhihuConfigured:true, llmConfigured:true（冻结密钥生效）, bankSize:92, requiresToken:true
首页 200 ｜ /js/app.js 200
无口令 → 401 ｜ 带口令 → 真实模型调用成功（技术深度 38 分，6.2s）
/api/usage → llm.calls:1, avgLatencyMs:6171
```

### 这一步抓到两个会让部署直接失败的坑

1. **打包时多跑了一步 `prepare-backend-package.js`** → 它把根 `package.json` 换成运行时清单（没有 workspaces）→ 平台第 2 步 `npm run build --workspace @zhimian/bff` 必然 `No workspaces found`。修法：打包不跑这步，交给平台。
2. **密钥固化写成内联字面量** → `(process.env.PDF_OCR || '1') === '1'` 变成 `("0" || '1') === '1'`，TypeScript 报 TS2367/TS2872（类型恒真/恒假）→ **构建失败**。
   修法：固化成 `FROZEN_ENV` 常量表（`Record<string, string>`），类型仍是 `string`，所有比较合法，探测器也看不到 `process.env` 读取。

> 结论：**上传前一定要在本机复刻平台 5 步**。这两类问题在本地开发环境完全看不出来。

---

## 附二：真实部署实测（2026-11-20 23:30 起，已跑通）

平台：**AI Works 项目广场**（`https://www.zhihu.com/project-square` → 创建项目 → 发布方式选「上传源码」→ 上传交付 ZIP）。
平台自己会**云端构建 + 部署**，并分配一个**免费公网域名**，不需要买域名（方案 C 的自购域名是给自建云主机用的，官方路径不需要）。

| 项 | 值 |
|---|---|
| 项目 ID | 240916 |
| 项目地址 | `https://www.zhihu.com/project/detail/240916` |
| **公网域名** | **`https://b3z5z9ztm5qo.aiworks.site`**（审核通过后生效） |
| 预览域名 | `https://b3z5z9ztm5qo.preview.aiworks.site`（需知乎 SSO 登录态） |
| 分享口令 | `zhimian--BqObUY_K7QAxrMB`（已固定进 `.env` 的 `PUBLIC_SHARE_TOKEN`，重建不再变） |
| 体验链接 | `https://b3z5z9ztm5qo.aiworks.site/?k=zhimian--BqObUY_K7QAxrMB` |

实测（全部不带知乎登录态）：
```
/api/health  → 200 {"ok":true,"zhihuConfigured":true,"llmConfigured":true,"bankSize":92,"requiresToken":true}
/             → 200（0.27s）    /js/app.js → 200
/api/bank 无口令 → 401
/api/coach/parse 带口令 → 200，7.0s，degraded:false，4 个维度分带 refIds
```

### 这一轮抓到的三个坑（本地全都测不出来）

| 坑 | 现象 | 根因 | 修法 |
|---|---|---|---|
| 1 `npm ci` 失败 | `EBADPLATFORM ... @botharness/cloudflared-win32-x64 ... current: {"os":"linux"}` | 交付包带了**本机隧道用的 Windows 专用依赖**；平台在 Linux 上构建 | `build-delivery.mjs` 新增 `stripHostOnlyDeps()`：交付副本里同步剔除 package.json 与 package-lock.json 中的平台限定包（仓库源码不动） |
| 2 函数 3 秒超时 | `Environment task timed out after 3 seconds`（ret_code 200401） | CloudBase HTTP 云函数**默认超时 3 秒**，LLM 调用必挂 | 官方 helper 没有超时开关，按 CloudBase 标准做法在交付副本 `cloudbaserc.json` 里显式设 `timeout: 60` + `memorySize: 512`；本地官方校验只对这一处有意偏离放行 |
| 3 网关约 15 秒上限 | 修完 2 仍返回 **554 空响应**（~16s 处被砍） | 模型**思考模式**把一次调用拖到 16–19s | 请求体加 `thinking: {type:'disabled'}`：同一 `deepseek-v4-flash`，completion 2657→571 token（reasoning 1750→0），延迟 16~19s→**3.9s**，诊断质量实测未下降。本地 LLM 从 5.5–13s 降到 3.3–3.5s |

> 教训：**平台模拟必须用 Linux 语义**。本机 Windows 上 `npm ci` 永远成功、模型延迟永远比云端低，
> 这两个坑本地一个都测不出来。

