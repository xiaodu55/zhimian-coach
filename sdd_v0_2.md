# SDD v0.2：知面陪练（知乎黑客松 S3 · AI × 陪伴与交互）

| 项 | 值 |
|---|---|
| 文档版本 | **v0.2**（v0.1 → v0.2 变更见 §0.2；**仍待批准，批准后我才开始写代码**） |
| 状态 | 待你批准 |
| 关联文档 | `PLAN.md`（战略与排期）、`SDD.md`（v0.1，被本文件取代）、`想法.md`、`小红书文案.md`、`作品稿.md`（提交用稿） |
| 作品名 / 队名 | **知面陪练 / 菜菜知面**（4 字 ≤12；队长=你，不可变更） |
| 想法链接 | `https://www.zhihu.com/pin/2105755975013746278` |
| 团队 | **单人队**（不拉队友） |
| 硬截止 | 作品提交 **2026-12-07 10:00**；报名 12.04 23:59；组队 12.07 10:00 |
| 本机工具链（已核实） | Node v24.14.1、pnpm 10.33.2、cargo/rustc 1.97.1、Edge WebView2 Runtime 157.0.4341.46 已装、**tauri CLI 未装**（`cargo install tauri-cli --version '^2'` 或 `pnpm add -D @tauri-apps/cli`） |
| 可参考的既有资产 | `D:/college/Harness/Supervision/apps/desktop/src-tauri`（Tauri v2 配置、NSIS、图标、Windows manifest 经验） |

---

## 0.1 v0.2 的一句话变更

**交付形态从"纯公网 Web"改成"同一份前端，双形态交付：公网 Demo（提报主交付） + Windows 桌面应用（选交加分）"，并为此把云端 BFF 从"可选"改为"必需"**（原因见 §6.1：知乎 Access Secret 与模型 Key 绝不能进客户端）。

## 0.2 v0.1 → v0.2 变更清单

| # | 变更 | 影响 |
|---|---|---|
| C1 | 队名 `菜菜队` → **`菜菜知面`**；作品名仍是 `知面陪练` | 若已建队，**队名可编辑、队长不变**，无需重建 |
| C2 | **单人队，不拉队友** | 决赛 5 分钟 Demo + 3 分钟 Q&A 全靠自己 → 新增 DoD：90 秒录屏备份 + 计划书按"一人三角色"写分工 + 至少一次全流程彩排 |
| C3 | 新增**桌面端交付**（Tauri v2 → Windows exe / zip 绿色版） | 前端复用（同一份 `apps/web`）；新增桌面壳与打包流程；见 §4.2 优先级与 §9 M13 |
| C4 | **BFF 由"可选"升为"必需"** | 你问"部署只需要静态吗"→ 不行：Secret 不能进客户端，BFF 是唯一解。但 BFF 极简（单服务 + KV），约 600 行 |
| C5 | 明确 **WebView2 无 Web Speech 云识别** → exe 内实时字幕不可用 | 三级降级方案见 §9 M3；exe 版 Demo 用"录音 + 导入转写稿 / 手动补录 / 本地 ASR（可选）"呈现 |
| C6 | 新增 **PWA 作为 exe 的保底替代** | 若 12.03 前 exe 没跑通，交付 PWA（可安装到桌面、离线壳），成本 ~1 人日 |
| C7 | 配额计量从"前端本地计数"改为 **BFF 侧匿名设备标识计量** | 单人预算变成全站预算，需服务端记账（§13） |

---

## 1. 目标与非目标

### 1.1 目标

| # | 目标 | 对应维度 |
|---|---|---|
| G1 | 录下一场面试/答辩，得到逐题可核对诊断（回指原话） | 完成度 25% |
| G2 | 评分基准来自知乎多元观点，每条结论带知乎来源链接 | 场景价值 40% + 创新 25% |
| G3 | 上传论文/PPT → 30 秒拿到"评委可能追问的 8–12 问 + 3 个高危薄弱点" | 场景价值 40% |
| G4 | 文档/转写稿 → 可溯源详解 → 就地追问 → 延伸检索；没有依据就说没有依据 | 创新 25% + 可信度 |
| G5 | 四模块闭环：读懂 → 说清 → 被追问 → 查清楚 | 场景价值 40% |
| G6 | **评委打开即用**（公网 Demo 免登录可体验核心流程）；接口失败有真实降级提示 | 完成度 + 提交硬门槛 |
| G7 | **同一套产品能装到评委电脑上当桌面应用跑**（可选加分），且客户端内零密钥 | 完成度 + 隐私叙事 |

### 1.2 非目标

| 不做 | 原因 |
|---|---|
| macOS / Linux 安装包 | 21 天单人，Windows 覆盖评委主流环境；作品表单按类型提交 |
| 代码签名 / 公证证书 | 证书与账号成本高、周期不可控 → 改为 **zip 绿色版优先 + 未签名安装包 + 明确说明** |
| 视频链接云端直连解析 | 本机 ffmpeg + faster-whisper 依赖，云端跑不了 |
| 知乎 OAuth 登录、收藏/关注同步 | App ID/App Key 12.05 才发（提交入口开放后），时间与不确定性都不划算 |
| 端到端加密、云端同步、账号体系 | 单人队不做账号；隐私靠"数据只在本机"实现 |
| 数据可视化图表、多端 App | 收益低、成本高 |

---

## 2. 术语

| 术语 | 定义 |
|---|---|
| 真题 / QuestionItem | 构建期从知乎检索得到的问题条目（上下文、难度、观点卡、标准答案骨架） |
| 观点卡 / ViewpointCard | 多观点对照最小单元：立场、摘要、证据句、来源链接、点赞数、主流/少数派标记 |
| 规则层 | 纯前端可跑的 10 条确定性诊断，输出带原话字符区间的结论 |
| 观点层 | LLM 基于观点卡做的评分与话术生成，输出必须锚定来源 |
| 三方对照 | 「你的回答 ⇄ 知乎主流观点 ⇄ 知乎分歧」并排视图 |
| 回流 | 薄弱点 → 弹药库「待复习」→ 优先复习置顶 → 生成下一题 |
| Citation / S 编号 | 统一引用（文档页码 / 视频时间戳 / 知乎回答 / 全网来源），编号形如 `S1` |
| 依据强度 | `原文直述 / 外部佐证 / 推断` 三级标注 |
| BFF | 后端-for-前端：唯一持有知乎 Secret 与模型 Key 的服务端 |

---

## 3. 用户与场景

| 角色 | 场景 | 成功标准 |
|---|---|---|
| 求职学生 | 面试前练 + 面后复盘 | 录一段 → 逐题诊断 → 薄弱点进复习队列 |
| 毕业生 | 论文/竞赛答辩 | 上传论文 → 预测提问 + 高危点 → 模拟答辩一次 |
| 学习者 | 读论文 / 看课程视频 | 看不懂的地方有人讲，且讲得有出处 |
| 评委 | 首次打开 | 30 秒理解这是什么、值不值，并愿意当场试一次 |

---

## 4. 功能范围与版本切片

### 4.1 版本切片

| 版本 | 时间 | 内容 | 出口条件 |
|---|---|---|---|
| **V0 骨架** | 11/17–11/19 | 仓库骨架、五屏空壳、BFF 健康检查、知乎代理 + 缓存 + 熔断、题库跑批脚本 | 跑通一次站内搜索并落 `question-bank.json` |
| **V1 P0** | 11/20–11/24 | 录音 + 字幕 + 转写解析、规则层 10 条、三方对照、改进话术、回流、陪练会话 | 录一段 → 诊断 → 回流全链路跑通 |
| **V2 P1/P1.5** | 11/25–12/01 | 答辩预测提问 + 委员会追问 + 预答辩报告；讲解（详解 + 追问 + 延伸 + 引用校验）；降级路径 | 答辩动线与讲解页可完整演示 |
| **V3 打磨** | 12/01–12/03 | UI/UX、窄屏、计划书稿、演示视频、提交自查 | 14 条验收（Web）全绿 |
| **V4 桌面端（选交）** | 12/03–12/06 | PWA 安装（保底）→ Tauri v2 exe / zip 绿色版 | 桌面端冷启动 ≤3s、录音可用、零密钥；失败则只交 PWA |

### 4.2 交付形态与优先级（回答"部署只需要静态吗 / 做 exe"）

| 形态 | 必要性 | 说明 |
|---|---|---|
| **公网 Demo（网页）** | **必须** | 赛规要求"可运行体验链接（公网可访问）"；评委不会为了评分去装 exe |
| **云端 BFF** | **必须** | 知乎 Access Secret 与模型 Key 只能在服务端；桌面端同样走它（客户端零密钥） |
| **PWA（可安装）** | 建议 | 成本 ~1 人日：manifest + Service Worker + 离线壳；桌面体验接近应用；**exe 失败时的保底** |
| **Windows exe（Tauri v2）** | 选交加分 | 复用同一前端；卖点是"真·本地应用、录音与材料不出本机"；风险：打包/未签名/SmartScreen（见 §9 M13） |
| **静态站单独部署** | **不可行** | 前端单独存在时，所有知乎与模型调用都要把密钥放浏览器 → 违反赛规与密钥纪律（§12） |

> 一句话回答你的问题：**前端可以纯静态，但整体不能只有静态 —— 必须有一个很轻的云端 BFF 兜住密钥、知乎调用与模型调用。** exe 反而让"BFF 必需"这件事更清晰：exe 里一个密钥都不能有。

---

## 5. 关键用户流程

### F1 面试闭环（P0）
```
1 选真题（题库 / 今日热榜 / 换一题）
2 开始录音 → 实时字幕逐句落时间戳（可点句就地编辑）｜ exe 版见 §9 M3 降级
3 或：导入会议转写稿 / 回放补录 / 手打要点
4 结束 → 解析（说话人切分 → Q&A 切分 → 规则层 → 观点层）
5 复盘台：三方对照 + 诊断（展开看原话/规则/知乎链接）+ 改进话术
6 标薄弱点 → 回流（弹药库置顶 + 生成下一题）
```
异常：模型超时 → 提示"已切换规则模式"（显式）；知乎不可用 → 本地题库 + "本次无外部对照"；字幕断线 → 提示并切手动补录，已识别内容保留。

### F2 答辩闭环（P1）
```
1 上传材料（PDF / md）→ 解析 → 关键主张与薄弱点
2 关联知乎质疑（按主题检索）→ 每条预测提问挂"知乎上有人这么质疑过"（链接 + 摘要）
3 报告：评委可能追问的 8–12 问（每问写"为什么会被问"）+ 3 个高危薄弱点
4 模拟答辩：主席开题 → 按薄弱处追问（可开"敌意评审"档）→ 录音 + 字幕
5 解析（同 F1）→ 预答辩报告导出 Markdown
```

### F3 讲解闭环（P1.5）
```
1 上传文档（PDF/md/txt）或视频转写稿 → 分段（带页码/时间戳定位符）
2 详解：章节骨架 → 每节「一句话结论 / 论证链 / 术语解释 / 易误解点」，每段挂 Citation
3 点段落追问 → 检索（文档内 BM25 → 知乎搜索 → 全网搜索 → 直答）→ 回答 + 依据 + 依据强度
4 继续检索相关知识 → 延伸阅读清单
5 存薄弱点 → 进入陪练复习队列
```

---

## 6. 系统架构

### 6.1 双形态架构图

```
                    ┌──────────────────────────────┐
  评委浏览器 ──────▶│  公网静态站 (apps/web)      │──┐
  （无需安装）      │  纯静态，零密钥              │  │
                    └──────────────────────────────┘  │  fetch (HTTPS)
                                                      ├──────────────┐
  评委桌面 ────────▶┌──────────────────────────────┐  │              ▼
  （可选加分）      │  Windows 应用                │  │   ┌────────────────────┐
  Tauri v2 / PWA    │  apps/desktop                │──┘   │  云端 BFF           │
                    │  同一份前端 + WebView2        │      │  apps/bff           │
                    │  零密钥 · 数据只在本机         │      │  · 知乎代理 + 缓存   │
                    └──────────────────────────────┘      │  · 熔断 + 配额记账   │
                                                          │  · LLM 代理         │
                                                          │  · 引用校验         │
                                                          │  · 文档解析         │
                                                          │  · OAuth（本期 501）│
                                                          └─────────┬──────────┘
                                                                    │ Secret/Key
                                                                    ▼
                                             知乎开放平台 API / 模型服务
```

### 6.2 目录

```
zhihu/
├─ apps/
│  ├─ web/                    前端（原生 ES modules，无构建）
│  │  ├─ index.html
│  │  ├─ js/{app,router,db,state,platform}.js      platform: 探测 Web / Tauri
│  │  ├─ js/screens/{bank,coach,review,ledger,explain}.js
│  │  ├─ js/capture/{recorder,caption,transcript}.js
│  │  ├─ js/rules/{diagnose,rules}.js
│  │  ├─ js/retrieval/{bm25,chunk}.js
│  │  ├─ js/ui/{components,citation,toast}.js
│  │  ├─ styles/app.css
│  │  └─ data/question-bank.json
│  ├─ bff/                    Node 20 + TypeScript + Hono（`tsc -p` → `dist/`，生产 `node dist/index.js`；运行期依赖 3 个）
│  │  └─ src/
│  │     ├─ server.js          # node:http + 自写路由分发 + 静态托管（可移植到 FC / Vercel / CF Pages）
│  │     ├─ config.js, errors.js, router.js
│  │     ├─ routes/{index,zhihu,coach,explain,auth,asr,client}.js
│  │     ├─ lib/{zhihuClient,cache,quota,llm,citations,docParser,prompts,device,static}.js
│  │     └─ lib/knowledge/{viewpoints,questionBank}.js
│  └─ desktop/               Tauri v2 壳（选交）
│     ├─ src-tauri/{Cargo.toml,tauri.conf.json,capabilities/,icons/}
│     └─ src/ (Rust：窗口、文件对话框、sidecar 调用位)
├─ scripts/build-bank/       离线题库跑批
├─ docs/{PLAN,SDD,SDD_v0_2,想法,小红书文案,作品稿}.md
├─ .env.example / .gitignore（含 .env）
└─ package.json              pnpm workspace
```

---

## 7. 配置与密钥

| 变量 | 位置 | 必需 | 说明 |
|---|---|---|---|
| `ZHIHU_ACCESS_SECRET` | **仅 BFF 环境变量** | 是 | 知乎开放平台 Secret；本地 `.env` 保存，**不进仓库** |
| `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` | **仅 BFF 环境变量** | 是 | 模型服务（minimax 优先，opencode go 兜底） |
| `BFF_BASE_URL` | 客户端（公开值，非密钥） | 是 | Web 端同域可空；**桌面端必填**，指向 `https://<你的域名>` |
| `PUBLIC_FEATURES` | 客户端（公开） | 否 | 功能开关（如 `oauth:false`、`asr:false`），由 BFF `/api/client-config` 下发 |
| `OAUTH_APP_ID` / `OAUTH_APP_KEY` / `OAUTH_REDIRECT_URI` | 仅 BFF | 否 | 12.05 建项目后拿到再填；无则 OAuth 路由 501，界面不暴露入口 |
| `DEVICE_SALT` | 仅 BFF | 否 | 匿名设备标识加盐（配额计量用） |

密钥纪律：**exe 与前端产物里出现任何 Secret 即取消资格**。提交前自查命令（§14 A12）。

---

## 8. 接口契约

### 8.1 BFF 路由（新增 `/api/client-config`、保留其余 v0.1 定义）

| 方法 | 路径 | 请求 | 响应 | 失败 |
|---|---|---|---|---|
| GET | `/api/health` | — | `{ok, zhihuConfigured, llmConfigured, bankSize, uptime}` | — |
| GET | `/api/client-config` | — | `{bffBaseUrl?, features:{oauth,asr,caption}, bankVersion}` | — |
| GET | `/api/bank` | `?q&track&limit` | `QuestionItem[]` | `VALIDATION_ERROR` |
| GET | `/api/bank/:id` | — | `QuestionItem` | `NOT_FOUND` |
| POST | `/api/zhihu/search` | `{query, scope:'zhihu'\|'global', count}` | `{results:[{title,snippet,url,type}]}` | `ZH_UPSTREAM_ERROR` / `ZH_QUOTA_EXHAUSTED` |
| POST | `/api/coach/session` | `{questionId, mode}` | `{sessionId, firstQuestion, viewAngleCards}` | `LLM_UNAVAILABLE`（降级） |
| POST | `/api/coach/turn` | `{sessionId, answer, transcript?}` | `{followups:[], parse:{ruleFindings[], llmScores[], improvements[]}, degraded}` | `LLM_UNAVAILABLE` → `degraded:true` + 规则层 |
| POST | `/api/coach/parse` | `{transcript\|answer, questionId?}` | `ParseReport` | 同上 |
| POST | `/api/defense/analyze` | `{materialId}` | `{predictedQuestions:[], topRisks:[]}` | `DOC_PARSE_FAILED` / `LLM_UNAVAILABLE` |
| POST | `/api/defense/session` | `{materialId, mode}` | `{sessionId, firstQuestion}` | 同上 |
| POST | `/api/explain/parse` | `{docId}` | `{outline:[], sections:[]}` | `DOC_PARSE_FAILED` |
| POST | `/api/explain/ask` | `{docId, sectionId?, question}` | `{answer, refs[], basis, noEvidence}` | `LLM_UNAVAILABLE` |
| POST | `/api/explain/extend` | `{docId, topic}` | `{items:[{title,summary,refs}]}` | `ZH_QUOTA_EXHAUSTED` |
| POST | `/api/doc/upload` | multipart | `{docId, title, pages, segments}` | `DOC_PARSE_FAILED` / `PAYLOAD_TOO_LARGE` |
| POST | `/api/asr` | 音频 | — | **501**（本期留口） |
| GET | `/api/auth/zhihu/start` | — | 302 | `OAUTH_NOT_CONFIGURED` |

统一错误体：`{error:{code,message,hint?}}`。

### 8.2 知乎开放平台调用

| 用途 | 端点 | 配额/天 | 缓存 |
|---|---|---|---|
| 站内搜索 | `GET https://developer.zhihu.com/api/v1/content/zhihu_search` | 5000 | 24h（key `zs:<sha1(q)>`） |
| 全网搜索 | `GET https://developer.zhihu.com/api/v1/content/global_search` | 5000 | 24h（`gs:<sha1(q)>`） |
| 热榜 | `GET https://developer.zhihu.com/api/v1/content/hot_list?Limit=10` | 100 | 1h |
| 直答 | `POST https://developer.zhihu.com/v1/chat/completions` | 100 | 不缓存 |
| 问题推荐 | `GET https://developer.zhihu.com/api/v1/user/question_recommendations?Count=5` | 100 | 5min |
| 回答摘要 | `GET https://developer.zhihu.com/api/v1/content/question_answers?QuestionUrl=…` | 100 | 随题库固化 |

鉴权：`Authorization: Bearer <Access Secret>` + `X-Request-Timestamp`（Unix 秒）。
跑批预算（**实测校准**）：问题推荐 ≤100/天、回答摘要 ≤100/天、直答 ≤100/天、站内搜索 ≤300/天；串行 + 0.6–1.5s 间隔；**每天稳定 20–40 题**，赛前目标 **60–120 题**。

> 实测结论：`question_recommendations` 才返回真正的**知乎问题**；搜索结果多为专栏文章标题，不能直接当题。`question_answers` 只返回 Summary/Url/ContentToken，**不含赞同数与作者名** → 界面不显示赞数，只显示来源链接（不虚报数据）。

### 8.3 LLM 代理与引用协议（防编造核心）

- 客户端**永不直连模型**；服务端拼装 prompt（题目 + 观点卡 + 历史对话 + 规则层发现项 + 文档片段）。
- 输出必须用 `[S1]` 标注依据，编号来自本次来源集合。
- **后处理校验（必须实现）**：抽取所有 `[S\d+]`；编号不在集合 → **丢弃该句**并计入 `droppedByValidator`；无编号且非"推断"类 → 丢弃。
- 依据强度前置标注：`原文直述 / 外部佐证 / 推断`；推断须写明推断依据。
- 无依据兜底：固定文案「未检索到直接依据，以下仅为基于已有材料的推断」+ 建议检索词 + `noEvidence:true`。
- 超时 20s / 失败 → `LLM_UNAVAILABLE` → 前端显式提示"已切换规则模式"。

### 8.4 文档解析

| 输入 | 方式 | 定位符 | 备注 |
|---|---|---|---|
| PDF | 服务端 `pdfjs-dist` 逐页取文本 + 段落切分 | `p12¶3` | 无文本层 → 明确提示"该 PDF 无文本层" |
| Markdown | `markdown-it` + 标题层级切块 | `p{h2}§3` | 保留标题路径面包屑 |
| TXT | 空行分段 | `¶12` | — |
| 视频转写稿 | 解析时间戳行头 | `12:30-13:05` | 支持 `[00:12:30] 文本` / `00:12:30 文本` |

### 8.5 错误码

| code | HTTP | 前端表现 |
|---|---|---|
| `VALIDATION_ERROR` | 400 | 表单内联提示 |
| `NOT_FOUND` | 404 | 空态 + 返回 |
| `ZH_AUTH_FAILED` | 502 | "知乎授权异常"，不展示任何密钥信息 |
| `ZH_QUOTA_EXHAUSTED` | 429 | "今日知乎额度已用完，已切本地题库/规则模式" |
| `ZH_UPSTREAM_ERROR` | 502 | "知乎接口暂不可用，已用缓存兜底" |
| `LLM_TIMEOUT` | 504 | "模型超时，已切换规则模式" |
| `LLM_UNAVAILABLE` | 503 | 同上 |
| `DOC_PARSE_FAILED` | 422 | "解析失败：<原因>"，可重试/换格式 |
| `PAYLOAD_TOO_LARGE` | 413 | "文件超过 20MB" |
| `OAUTH_NOT_CONFIGURED` | 501 | 隐藏 OAuth 入口 |
| `CAPABILITY_UNAVAILABLE` | 501 | 桌面端未配置 `BFF_BASE_URL` / 功能未启用时的统一提示 |

---

## 9. 模块规格

| ID | 模块 | 职责 | 验收（可观察） |
|---|---|---|---|
| M1 | 题库构建 | 跑批生成 `question-bank.json` | ≥60 题（分批，配额 100/天×3）；每题 ≥2 条来源 + ≥2 张观点卡（含少数派）；卡含 `sourceUrl` 与逐字校验过的 `evidence`；证据命中率作为指标输出 |
| M2 | 录音 | MediaRecorder + opus，本地存 | 录 30s 可回放；刷新仍在；**无任何上传请求** |
| M3 | 字幕 | Web Speech API 逐句落时间戳；可点句编辑 | 见下方"形态差异表" |
| M4 | 转写解析 | 说话人标签 + Q&A 切分 | 带标签稿正确切分；无标签启发式切分 ≥80%（用内置样例测） |
| M5 | 规则诊断 | 10 条规则（§10） | 每条含规则名 + 原话 + 字符区间 + 建议；无原话不得产出 |
| M6 | 观点层解析 | 观点卡对照 + 四维评分 + 话术 | 每条评分带 ≥1 个 `[S编号]`；无锚点句被丢弃；UI 标注"已过滤无依据结论" |
| M7 | 三方对照 | 回答 / 主流观点 / 分歧 并排 | 观点卡可点开跳原知乎链接 |
| M8 | 陪练会话 | 提问 + 连续追问（≤3 层）+ 分歧驱动 | ✅ 第 4 轮返回 `CAPABILITY_UNAVAILABLE`（实测）；✅ 模型失败前端显式提示"已切换规则模式" |
| M9 | 答辩预测 | 材料解析 + 预测提问（挂知乎质疑）+ 报告 | ≤30s 出 8–12 问 + 3 高危点；≥2 问挂知乎链接；报告可导出 Markdown |
| M10 | 讲解引擎 | 详解 + 追问 + 延伸 + 引用校验 | 详解每段 ≥1 引用；回答带依据强度；无果时 `noEvidence:true` 且不编造 |
| M11 | 回流与台账 | 薄弱点 → 弹药库 → 优先复习 → 生成下一题 | 标「已挂」+ 勾归因后条目置顶 |
| M12 | 降级与配额 | 熔断、缓存、预算、显式提示 | 断网/超配额仍能跑规则层；降级都有可见文案 |
| **M13** | **桌面端封装**（选交） | Tauri v2 壳：窗口、文件对话框、sidecar 调用位、零密钥 | 冷启动 ≤3s；录音可用；产物内 `strings` 扫描无 Secret；提供 zip 绿色版 + 安装包；未签名需在提交说明中写清 |

### M3 形态差异表（关键约束）

| 能力 | 公网 Web（Chrome/Edge） | Tauri / WebView2 | 处置 |
|---|---|---|---|
| MediaRecorder 录音 | ✅ | ✅（WebView2 支持 webm/opus） | 两形态一致 |
| 实时字幕 Web Speech API | ✅ Edge 最佳（Azure） | ❌ **WebView2 无 Chrome 云识别服务** | exe 版：① 导入会议转写稿 ② 手动/回放补录 ③ **可选**：Tauri sidecar 调本机 whisper.cpp（P1，排期外则砍） |
| 字幕就地编辑 | ✅ | ✅ | 一致 |
| 本地存储 | IndexedDB | WebView2 的 IndexedDB | 一致（桌面端用 app 专属目录，卸载即清） |
| 网络出口 | 仅 BFF | 仅 BFF（可在日志中自证） | 一致，隐私叙事成立 |

> 结论：exe 版的"字幕"能力弱于网页版，**Demo 时不要承诺实时字幕**；把差异写进提交说明，评分上诚实比吹大更安全。

---

## 10. 规则表（规则层，10 条）

| # | ruleId | 检测方式 | 级别 |
|---|---|---|---|
| 1 | `followup_unresolved` | 同一问题被连续追问且未答透 | red |
| 2 | `no_metric` | 回答中具体数字/指标数量 = 0 | red |
| 3 | `metric_no_baseline` | 给了数字但未说明口径/基线 | amber |
| 4 | `star_missing` | 情境/任务/行动/结果 命中 < 3 | red |
| 5 | `we_not_i` | 「我们」次数 > 「我」 | amber |
| 6 | `vague_time` | 「之前/一段时间/后来/之后」等无锚点时间词 | amber |
| 7 | `off_topic` | 问题关键词覆盖率 < 阈值 | red |
| 8 | `filler_density` | 嗯/啊/那个/就是/然后 每百字计数超阈值 | amber |
| 9 | `length_mismatch` | 回答字数与题型期望区间不符 | amber |
| 10 | `no_restate` | 前 20 字未复述/确认问题 | amber |

---

## 11. 前端规格

| 屏 | 内容 | 状态 |
|---|---|---|
| 首页 / 题库 | 定位 + 一键体验 + 题库筛选 + 今日热榜 | `idle→loading→ready/empty/error` |
| 陪练室 | 题目卡 + 观点卡预览 + 答题区（打字/录音/字幕）+ 追问流 | `choosing→recording→parsing→answered` |
| 复盘台 | 三方对照 + 诊断（可展开）+ 改进话术 + 回流 | `ready→expanded→archived` |
| 台账 | 状态机 + 每场下钻 + 归因 + 优先复习队列 | 12 态沿用 AfterAnswer |
| 讲解室 | 上传 → 详解（引用 chip）→ 追问 → 延伸 → 存薄弱点 | `upload→parsing→explained→asking→extended` |

体验硬指标：首屏可交互 ≤1.5s；375px 窄屏可用；键盘可达；对比度 AA；加载/空/错/降级四态齐全；引用 chip 三种样式（页码 / 时间戳 / 知乎链接）可展开原文对照；两形态视觉一致；桌面端窗口默认 1280×860、最小 1024×680。

---

## 12. 安全与隐私

| 项 | 要求 |
|---|---|
| 密钥 | 仅 BFF 环境变量；**桌面端与前端产物零密钥**（提交前对 exe 做 `strings`/资源扫描自查） |
| 用户内容 | 录音、转写稿、答题记录、答辩材料 **只在本机**（IndexedDB / app 目录）；服务端只缓存公开知乎内容与跑批产物 |
| 出口可自证 | 客户端仅向自己的 BFF 发请求；页面提供"本机数据不出设备"的说明与导出 JSON 入口 |
| 账号 | 无账号体系；匿名设备标识仅用于配额计量，加盐不可反推 |
| 第三方 | 仅知乎官方开放能力 + 所选模型服务；无追踪、无埋点、无第三方素材 |
| API 规范 | 只读检索 + 本地生成，**不做任何内容发布接口调用** |
| 提交前 | grep 源码 + 扫描 exe；演示账号不复用个人账号 |

---

## 13. 配额与降级

| 场景 | 预算 | 超限 | 降级链 |
|---|---|---|---|
| 站内/全网搜索 | 线上 ≤30/天 | 429 | 本地题库 → 只出规则层 |
| 直答 | 单设备 ≤5/天，全站 ≤80/天 | 429 | 规则层 + 模板追问句 |
| 热榜 | 1 次/天 | 缓存 | 昨日榜单 |
| LLM | 20s 超时 | 504/503 | 规则层（显式提示） |
| 上游连续失败 | 连续 5 次 | 熔断 60s | 缓存数据 |

计量主体：**BFF 侧匿名设备标识**（HttpOnly cookie + `DEVICE_SALT`），Web 与桌面端共用同一预算池。

---

## 14. 验收清单（提交前逐条跑）

| # | Given | When | Then |
|---|---|---|---|
| A1 | 访问公网 Demo | 打开站点 | ≤1.5s 看到定位与体验入口，无控制台报错 |
| A2 | 陪练室 | 录 20 秒并停止 | 可回放；字幕有句子与时间戳；**无上传请求** |
| A3 | 导入带说话人标签的样例转写 | 点击解析 | 正确切出 Q&A；每题 ≥1 条可展开诊断且能定位原话 |
| A4 | 解析完成 | 查看诊断 | 每条含规则名 + 原话 + 建议；观点层结论带 `[S编号]` 且可点开来源 |
| A5 | 模型不可用 | 触发解析 | 明确提示"已切换规则模式"，规则层结论照常输出 |
| A6 | 上传论文 PDF | 生成预测提问 | ≤30s 得 8–12 问 + 3 高危点；≥2 问挂知乎质疑链接 |
| A7 | 上传 md | 生成详解 | 每段带引用 chip，点 chip 可定位原文 |
| A8 | 提问且检索无果 | 查看回答 | 显示"未检索到直接依据"+ 建议检索词，**不出现编造答案** |
| A9 | 标「已挂」+ 勾归因 | 查看弹药库 | 相关条目置顶于「优先复习」，可一键生成练习题 |
| A10 | 375px 窄屏 | 浏览五屏 | 无横向滚动，主操作可达 |
| A11 | 断网 | 打开站点 | 静态资源与题库可用，接口错误有显式提示 |
| A12 | 提交前 | grep + 扫描前端产物与 exe | 无 Secret / 明文 API Key |
| A13 | 想法链接 | 建队表单 | 校验通过（含 `www.zhihu.com/pin`） |
| A14 | 提报当天 | 走 9 条提交自查 | 全过，无 Mock 占位冒充交付 |
| **A15** | **桌面端（若交付）** | **冷启动 exe** | **≤3s 可用；录音可录可回放；无密钥；提供 zip 绿色版** |
| **A16** | **两形态对比** | **跑同一场景** | **除实时字幕外功能一致；差异在提交说明中写明** |
| **A17** | **公网地址** | **打开 Demo 并授权麦克风** | **地址为 https，`getUserMedia` 可用，录音能录能回放** |
| **A18** | **FC 发布** | **把别名切回上一版本** | **1 分钟内完成回滚（赛前演练一次并记录用时）** |

---

## 15. 里程碑与 DoD

| 里程碑 | 日期 | DoD |
|---|---|---|
| M0 骨架 | 11/19 | `pnpm dev` 可起；`/api/health` 正常；跑批落库（✅ 已达成：38 题 + 15 题观点卡 / 56 张卡） |
| M1 录音解析 | 11/24 | A2–A5 通过（✅ 已实现：录音/字幕/转写切分/规则层10条/三方对照/回流；⚠️ 麦克风实录待真人验证） |
| M2 陪练闭环 | 11/26 | A3、A9 通过（✅ 已达成：三方对照使用真实观点卡）；✅ 观点层已接（四维评分 + ≤3 轮追问 + 引用校验单测通过） |
| M3 答辩 + 讲解 | 11/29 | A6–A8 通过；预答辩报告可导出 |
| M4 打磨 + 稿 | 12/03 | A1、A10、A11 通过；`作品稿.md` 补齐真实截图与实测数字 |
| M5 桌面端（选交） | 12/05 | A15、A16 通过；否则只交 PWA |
| M6 提报 | 12/05–12/06 | A12–A14 通过；作品已提报；想法运营已启动 |

**单人队附加 DoD**：① 全流程彩排 ≥1 次并录 90 秒备用视频；② 计划书按"一人三角色（产品 / 工程 / 运营）"写分工；③ Q&A 预案 ≥8 条。

---

## 15.5 部署与运维（详见 `部署方案.md`）

| 项 | 决定 |
|---|---|
| 平台（默认） | 阿里云函数计算 FC 3.0，Web 函数（Node.js 20），同域 serve 静态 + API |
| **降级链（时间盒）** | FC 90 分钟未跑通 → **Cloudflare Pages + Pages Functions**（30 分钟）→ **Vercel**（20 分钟）。三档任一成功即达标，不再加平台 |
| **可移植性前提** | 前端零构建（原生 ES modules）；BFF 为 TS + Hono，`tsc` 出 `dist/`，运行期仅 hono/dotenv/markdown-it 三个依赖 —— 降级到 Vercel/CF 需带 `node_modules`，不再是"零依赖"→ 同一份代码三处可跑；唯一重依赖 PDF 解析可关闭（`FEATURE_PDF=off`，界面显式标注"暂不支持 PDF"） |
| 域名 | 先用平台默认域名（**免备案**）；自定义域名待 ICP 备案后绑定 |
| HTTPS | **必须 https**：录音 `getUserMedia` 仅在安全上下文可用（`部署方案.md` C1） |
| 密钥 | 只进服务端环境变量（或 KMS 引用）；CI 用 RAM 角色/OIDC，不落长期 AK |
| 日志 | SLS（或平台日志），只记 requestId / 路由 / 状态码 / 耗时 / 错误码，**不记用户内容**；告警：5xx>1%、配额耗尽、模型连续失败、证书到期 |
| 发布 | 版本 + 别名：staging 别名冒烟 → 切 production → 观察 → 异常立即切回（目标 1 分钟内回滚） |
| 时机 | **部署动作排在 12.01 之后**（功能定稿再做，避免反复改）；首次尝试即 FC |
| 加练线 | 海外轻量服务器 staging：Nginx / certbot 自动续期 / systemd / fail2ban / 日志轮转 / 回滚脚本 |
| 禁止 | 12.07 前不做 ICP 备案（7–20 天，来不及）；不在中国大陆服务器上用未备案自定义域名 |

---

## 16. 待你确认（默认已按你的最新决定设定）

| # | 问题 | 默认 |
|---|---|---|
| Q1 | 模型服务 API（base_url / 模型名 / key 形态） | minimax 优先 + opencode go 兜底；配置写进 `.env` |
| Q2 | BFF 部署 | **默认阿里云 FC 3.0（同域 serve 静态 + API，免备案默认域名）**；时间盒内未跑通则降级 Cloudflare Pages（30 分钟）→ Vercel（20 分钟）。BFF 零依赖保证三处可跑。详见 `部署方案.md` |
| Q3 | OAuth | 不做（`/api/client-config` 下发 `oauth:false`，前端不露入口） |
| Q4 | 队友 | 不拉，单人队（已按此调整风险项） |
| Q5 | 桌面端形态 | Tauri v2 → Windows 安装包 + **zip 绿色版**；未签名，提交说明写清 |
| Q6 | exe 内实时字幕 | **不做**（WebView2 不支持）；用导入转写稿 / 手动补录呈现，差异写进提交说明 |
| Q7 | PWA | 做（~1 人日），作为 exe 的保底与"可安装"叙事 |
| Q8 | 题库规模 | **60–120 题**（配额 100/天×3 的硬约束，每天 20–40 题，可断点续跑）；不追求 500+ |
| Q9 | 队名 | `菜菜知面`（**若已建队可直接改名，队长不变**） |
| Q10 | 提交形态组合 | 必交：公网 Demo + 计划书；选交：exe/绿色版 + 仓库 + 视频（+ PWA） |

---

## 17. 审批

- [ ] 确认 SDD v0.2（范围、模块、接口、桌面端方案、验收、排期）
- [ ] 确认 Q1–Q10（可回"按默认"）
- [ ] 授权开始写代码（先 V0 骨架）
- [ ] 补充：Access Secret 由我在 `developer.zhihu.com/profile` 生成后写入 `.env`（不经对话）

**任何范围变更先改本文档，再改代码。**
