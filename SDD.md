# SDD：知面陪练（知乎黑客松 S3 · AI × 知识与探索）

| 项 | 值 |
|---|---|
| 文档版本 | v0.1（待评审） |
| 状态 | **待你批准 → 批准后我才开始写代码** |
| 关联文档 | `PLAN.md`（战略与排期）、`想法.md`（公开文案）、`小红书文案.md`（导流） |
| 作品名 / 队名 | 知面陪练 / 菜菜队 |
| 想法链接 | `https://www.zhihu.com/pin/2105755975013746278` |
| 硬截止 | 作品提交 **2026-12-07 10:00**；报名 12.04 23:59；组队 12.07 10:00 |
| 代码仓库 | 新建独立仓库（不复用 Qoder 项目的 git 历史；复用代码片段须在文件头标注来源） |

---

## 1. 目标与非目标

### 1.1 目标（评审维度对齐）

| # | 目标 | 对应评审维度 |
|---|---|---|
| G1 | 用户能**录下**一场面试/答辩，并得到逐题可核对的诊断（回指原话） | 完成度 25% |
| G2 | 诊断的评分基准来自**知乎的多元观点**，不是某个模型的口味；每条结论带知乎来源链接 | AI 场景价值 40% + 创新度 25% |
| G3 | 评委上传论文/PPT，30 秒内拿到"评委可能追问的 8–12 问 + 3 个高危薄弱点"，最难缠的问附知乎真实质疑 | AI 场景价值 40%（差异化） |
| G4 | 上传文档/视频转写稿 → 可溯源详解 → 就地追问 → 延伸检索；**检索不到就说检索不到** | 创新度 25% + 可信度 |
| G5 | 四个模块连成一条闭环：读懂 → 说清 → 被追问 → 查清楚 | AI 场景价值 40%（产品完整性） |
| G6 | 评委打开即用（公网 Demo、免登录可体验核心流程）、接口失败有真实降级提示 | 完成度 25% + 提交硬性门槛 |

### 1.2 非目标（本版本明确不做，避免范围蔓延）

| 不做 | 原因 | 何时再考虑 |
|---|---|---|
| 视频链接云端直连解析（抓字幕 / ASR） | 本机 `video-digest` 依赖本地 ffmpeg + faster-whisper，云端跑不了 | V2，接入 `/api/asr` 或平台字幕接口 |
| 知乎 OAuth 登录 + 收藏/关注同步 | App ID/App Key 领取时机官方未明确（提交入口 12.05 才开） | 凭据到手后 48 小时内评估，能做才做 |
| 多端 App / 桌面客户端 | 本届交付物是公网网页 | 赛后 |
| 数据可视化图表（visuals.json） | 成本高、收益集中在 8% 的体验分 | 12.01 前若有余力 |
| 自动投递 / 海投 / 简历解析 | 与作品主线无关 | 永不做 |
| 团队协作 / 多人共享题库 | 单人交付 | 永不做 |

---

## 2. 术语

| 术语 | 定义 |
|---|---|
| 真题 / QuestionItem | 构建期从知乎检索得到的问题条目，含上下文、难度、观点卡、标准答案骨架 |
| 观点卡 / ViewpointCard | 某个知乎问题的多观点对照最小单元：立场、摘要、证据句、来源链接、点赞数、`popularity` |
| 规则层 | 纯前端可跑的 10 条确定性诊断规则，输出带原话字符区间的结论 |
| 观点层 | LLM 基于观点卡做的评分与话术生成，输出必须锚定来源 |
| 三方对照 | 「你的回答 ⇄ 知乎主流观点 ⇄ 知乎分歧」并排视图 |
| 回流 | 复盘中标记的薄弱点 → 弹药库「待复习」→ 优先复习置顶 → 生成下一道练习题 |
| Citation / S 编号 | 统一引用结构（文档页码 / 视频时间戳 / 知乎回答 / 全网来源），编号形如 `S1` |
| 依据强度 | `原文直述` / `外部佐证` / `推断` 三级标注 |

---

## 3. 用户与场景

| 角色 | 场景 | 关键诉求 | 成功标准 |
|---|---|---|---|
| 求职学生 | 面试前练 + 面后复盘 | 知道自己哪句答砸了，下次怎么改 | 录一段 → 看到逐题诊断 → 薄弱点进复习队列 |
| 毕业生 | 论文答辩 / 竞赛答辩 | 提前知道评委会挑什么刺 | 上传论文 → 拿到预测提问 + 高危点 → 模拟答辩一次 |
| 学习者 | 读论文 / 看课程视频 | 看不懂的地方有人讲，且讲得有出处 | 上传文档 → 详解 → 就地追问 → 延伸阅读 |
| 评委 | 首次打开 Demo | 30 秒内理解这是什么、值不值 | 首页能看到一句话定位 + 一键体验入口 |

---

## 4. 功能范围与版本切片

| 版本 | 时间 | 内容 | 出口条件 |
|---|---|---|---|
| **V0 骨架** | 11/17–11/19 | 仓库骨架、五屏空壳、BFF 健康检查、知乎代理 + 缓存 + 熔断、题库跑批脚本 | 能跑通 `zhihu_search` 一次并落库 |
| **V1 P0** | 11/20–11/24 | 录音 + 字幕 + 转写解析、规则层 10 条诊断、三方对照、改进话术、回流、陪练会话 | 录一段 → 诊断 → 回流全链路跑通 |
| **V2 P1/P1.5** | 11/25–12/01 | 答辩预测提问 + 委员会追问 + 预答辩报告；讲解（详解 + 追问 + 延伸 + 引用校验）；降级路径 | 答辩动线 B 与讲解页可完整演示 |
| **V3 打磨** | 12/01–12/04 | UI/UX、移动端窄屏、计划书、演示视频、提交前自查 | 9 条自查全绿 |

---

## 5. 关键用户流程

### F1 面试闭环（P0）

```
1 选真题（题库浏览 / 今日热榜话题 / "换一题"）
2 开始录音 → 实时字幕逐句落时间戳（可点句就地编辑）
3 或：导入会议转写稿 / 回放补录 / 手打要点
4 结束 → 解析（说话人切分 → Q&A 切分 → 规则层 → 观点层）
5 复盘台：三方对照 + 诊断（可展开看原话/规则/知乎链接）+ 改进话术
6 标记薄弱点 → 回流（弹药库置顶 + 生成下一题）
```

异常分支：
- 模型超时 → 提示"模型暂不可用，已切换规则模式"，只出规则层结论（显式提示，不静默）
- 知乎不可用 → 读本地题库 + 观点层标注"本次无外部对照"
- 字幕断线 → 提示并允许切"手动补录"，已识别内容保留

### F2 答辩闭环（P1）

```
1 上传材料（PDF / PPT→md / md）→ 服务端解析 → 抽取关键主张与薄弱点
2 关联知乎质疑：按主题检索 → 每条预测提问挂"知乎上有人这么质疑过"（链接 + 摘要）
3 出报告：评委可能追问的 8–12 问（每问写"为什么会被问"）+ 3 个高危薄弱点
4 模拟答辩：主席开题 → 按薄弱处追问（可开"敌意评审"档）→ 录音 + 字幕
5 解析（同 F1）→ 预答辩报告导出（Markdown）
```

### F3 讲解闭环（P1.5）

```
1 上传文档（PDF/md/txt）或视频转写稿 → 分段（带页码/时间戳定位符）
2 详解：章节骨架 → 每节「一句话结论 / 论证链 / 术语解释 / 易误解点」，每段挂 Citation
3 用户点段落追问 → 检索（文档内 BM25 → 知乎搜索 → 全网搜索 → 直答）→ 回答 + 依据 + 依据强度
4 "继续检索相关知识" → 延伸阅读清单（知乎高赞实测 + 一手资料）
5 "这个我没懂" → 存为薄弱点 → 进入陪练复习队列（与 F1/F2 打通）
```

---

## 6. 系统架构与目录

```
zhihu/
├─ apps/
│  ├─ web/                      静态站（无构建，原生 ES modules）
│  │  ├─ index.html
│  │  ├─ js/{app,router,db,state}.js
│  │  ├─ js/screens/{bank,coach,review,ledger,explain}.js
│  │  ├─ js/capture/{recorder,caption,transcript}.js
│  │  ├─ js/rules/{diagnose,rules}.js
│  │  ├─ js/retrieval/{bm25,chunk}.js
│  │  ├─ js/ui/{components,citation,toast}.js
│  │  ├─ styles/app.css
│  │  └─ data/question-bank.json     构建期产物，随站发布
│  └─ bff/                      Node 20 + TypeScript + Hono（同域同时 serve 静态与 API）
│     └─ src/
│        ├─ index.ts                    入口：static + routes
│        ├─ config.ts                   环境变量读取与校验（缺 Secret 启动即报错）
│        ├─ routes/{zhihu,coach,explain,auth,asr}.ts
│        ├─ lib/{zhihuClient,cache,quota,llm,citations,docParser,prompts}.ts
│        └─ lib/knowledge/{viewpoints,questionBank}.ts
├─ scripts/build-bank/          离线题库跑批（读 .env，不进浏览器）
│  ├─ run.ts                       主流程：检索 → 取回答摘要 → 生成观点卡 → 落 JSON
│  └─ prompts.ts
├─ docs/{PLAN,SDD,想法,小红书文案}.md
├─ .env.example                 只放键名与说明，不放值
└─ package.json                 pnpm workspace
```

技术选型理由（不摇摆）：静态站免构建、评委打开即用；Hono 单服务同时供 API 与静态，规避 CORS；TypeScript 与你现有栈一致；跑批脚本与线上服务共用同一套 `zhihuClient`（避免"脚本能跑、线上跑不通"）。

---

## 7. 配置与密钥

| 变量 | 必需 | 说明 |
|---|---|---|
| `ZHIHU_ACCESS_SECRET` | 是 | 知乎开放平台 Access Secret，**只在服务端**；`.env` 本地保存，**不进仓库**（`.gitignore` 含 `.env`） |
| `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` | 是 | 陪练与解析用的模型服务（可用你的 minimax / opencode go 订阅所对应的 API） |
| `PORT` / `NODE_ENV` | 否 | 默认 8787 |
| `OAUTH_APP_ID` / `OAUTH_APP_KEY` / `OAUTH_REDIRECT_URI` | 否 | 12.05 建项目后拿到再填；无则 OAuth 路由直接 501（功能不暴露） |
| `CACHE_TTL_HOURS` | 否 | 默认 24（搜索类） |

密钥纪律：只进服务端环境变量；不进源码、不进 URL、不进日志、不进前端响应、不进 Agent 输出；提交前用 `grep -rn "Access Secret\|api_key\|Bearer " apps/` 自查（排除 `.env`）。

---

## 8. 接口契约

### 8.1 BFF 路由

| 方法 | 路径 | 请求 | 响应 | 失败 |
|---|---|---|---|---|
| GET | `/api/health` | — | `{ok, zhihuConfigured, llmConfigured, bankSize}` | — |
| GET | `/api/bank` | `?q&track&limit` | `QuestionItem[]` | `VALIDATION_ERROR` |
| GET | `/api/bank/:id` | — | `QuestionItem` | `NOT_FOUND` |
| POST | `/api/zhihu/search` | `{query, scope:'zhihu'\|'global', count}` | `{results:[{title,snippet,url,type}]}` | `ZH_UPSTREAM_ERROR` / `ZH_QUOTA_EXHAUSTED` |
| POST | `/api/coach/session` | `{questionId, mode}` | `{sessionId, firstQuestion, viewAngleCards}` | `LLM_UNAVAILABLE`（降级：只返 viewAngleCards + 首个模板问句） |
| POST | `/api/coach/turn` | `{sessionId, answer, transcript?}` | `{followups:[], parse:{ruleFindings[], llmScores[], improvements[]}, degraded}` | `LLM_UNAVAILABLE` → 返回 `degraded:true` + 规则层结果 |
| POST | `/api/coach/parse` | `{transcript \| answer, questionId?}` | `ParseReport` | 同上 |
| POST | `/api/defense/analyze` | `{materialId}` | `{predictedQuestions:[DeliverableQA], topRisks:[]}` | `DOC_PARSE_FAILED` / `LLM_UNAVAILABLE` |
| POST | `/api/defense/session` | `{materialId, mode}` | `{sessionId, firstQuestion}` | 同上 |
| POST | `/api/explain/parse` | `{docId}` | `{outline:[], sections:[]}` | `DOC_PARSE_FAILED` |
| POST | `/api/explain/ask` | `{docId, sectionId?, question}` | `{answer, refs:Citation[], basis, noEvidence}` | `LLM_UNAVAILABLE` |
| POST | `/api/explain/extend` | `{docId, topic}` | `{items:[{title,summary,refs}]}` | `ZH_QUOTA_EXHAUSTED` |
| POST | `/api/doc/upload` | multipart 文件 | `{docId, title, pages, segments}` | `DOC_PARSE_FAILED` / `PAYLOAD_TOO_LARGE`（上限 20MB） |
| POST | `/api/asr` | 音频 | — | **501 Not Implemented**（本期留口，界面不暴露入口） |
| GET | `/api/auth/zhihu/start` | — | 302 到授权页 | `OAUTH_NOT_CONFIGURED` |

统一错误体：`{ error: {code, message, hint?} }`；`code` 见 §8.5。

### 8.2 知乎开放平台调用（服务端）

| 用途 | 端点 | 鉴权 | 配额/天 | 缓存 |
|---|---|---|---|---|
| 站内搜索 | `GET https://developer.zhihu.com/api/v1/content/zhihu_search` | `Authorization: Bearer <Access Secret>` + `X-Request-Timestamp`（Unix 秒） | 5000 | 24h，key = `zs:<sha1(query)>` |
| 全网搜索 | `GET https://developer.zhihu.com/api/v1/content/global_search` | 同上 | 5000 | 24h，key = `gs:<sha1(query)>` |
| 热榜 | `GET https://developer.zhihu.com/api/v1/content/hot_list?Limit=10` | 同上 | 100 | 1h |
| 直答 | `POST https://developer.zhihu.com/v1/chat/completions` | 同上 | 100 | 不缓存（会话内可复用） |
| 问题推荐 | `GET https://developer.zhihu.com/api/v1/user/question_recommendations?Count=5` | 同上 | 100 | 5min |
| 回答摘要 | `GET https://developer.zhihu.com/api/v1/content/question_answers?QuestionUrl=…` | 同上 | 100 | 随题库固化 |

跑批（构建期）预算：站内搜索 ≤ 300、全网搜索 ≤ 300、回答摘要 ≤ 100/天、直答 ≤ 100/天；串行 + 1s 间隔 + 单次失败重试 ≤2；产出 `question-bank.json`（目标 60–120 题，分批）。

> 注：本文档为 v0.1，题库口径已被 `sdd_v0_2.md` 修正（练习单元=知乎问题，而非搜索到的文章标题）。

### 8.3 LLM 代理与引用协议（关键防编造设计）

- 请求：服务端拼装 prompt（题目 + 观点卡 + 历史对话 + 规则层发现项 + 文档片段），**客户端永远不直连模型**。
- 输出协议：模型必须用 `[S1]`、`[S2]` 标注依据；`S` 编号来自本次提供的来源集合。
- **后处理校验（必须实现）**：正则抽取所有 `[S\d+]`；编号不在来源集合 → **丢弃该句**并计入 `droppedByValidator`；全句无编号且不属于"推断"类 → 丢弃。
- 依据强度标注：每条结论前置 `原文直述 / 外部佐证 / 推断`；`推断` 必须写出推断依据。
- 无依据兜底：检索无结果时，返回固定文案「未检索到直接依据，以下仅为基于已有材料的推断」+ 建议检索词，`noEvidence:true`。
- 超时 20s / 失败 → `LLM_UNAVAILABLE`，前端显式提示"已切换规则模式"，不静默失败。

### 8.4 文档解析

| 输入 | 解析方式 | 定位符 | 备注 |
|---|---|---|---|
| PDF | 服务端 `pdfjs-dist` 逐页取文本 + 段落切分 | `p12¶3` | 扫描件（无文本层）→ 明确提示"该 PDF 无文本层，请上传可复制文本的版本" |
| Markdown | `markdown-it` 解析 + 标题层级切块 | `p{h2}§3` | 保留标题路径面包屑 |
| TXT | 空行分段 | `¶12` | — |
| 视频转写稿 | 解析 `timestamp` 行头 | `12:30-13:05` | 格式：`[00:12:30] 文本` 或 `00:12:30 文本`；时间戳可选回链视频 |

### 8.5 错误码

| code | HTTP | 前端表现 |
|---|---|---|
| `VALIDATION_ERROR` | 400 | 表单内联提示 |
| `NOT_FOUND` | 404 | 空态 + 返回按钮 |
| `ZH_AUTH_FAILED` | 502 | "知乎授权异常（密钥缺失或失效）"，提示联系作者；不展示任何密钥信息 |
| `ZH_QUOTA_EXHAUSTED` | 429 | "今日知乎接口额度已用完，已切换本地题库 / 规则模式" |
| `ZH_UPSTREAM_ERROR` | 502 | "知乎接口暂时不可用，已用缓存/本地数据兜底" |
| `LLM_TIMEOUT` | 504 | "模型响应超时，已切换规则模式" |
| `LLM_UNAVAILABLE` | 503 | 同上 |
| `DOC_PARSE_FAILED` | 422 | "解析失败：<原因>"，可重试或换格式 |
| `PAYLOAD_TOO_LARGE` | 413 | "文件超过 20MB" |
| `OAUTH_NOT_CONFIGURED` | 501 | 隐藏 OAuth 入口 |

---

## 9. 模块规格

| ID | 模块 | 职责 | 关键验收（可观察） |
|---|---|---|---|
| M1 | 题库构建 | 跑批生成 `question-bank.json` | 产出 ≥500 题；每题含 ≥2 张观点卡（主流 + 至少一张少数派）；每张卡含 `sourceUrl` 与 `evidenceQuote`；JSON 中不得出现空 `sourceUrl` |
| M2 | 录音 | MediaRecorder + opus，本地存 IndexedDB | 录 30 秒 → 可回放；刷新后仍在；不产生任何上传请求（网络面板无 media 上传） |
| M3 | 字幕 | Web Speech API 逐句落时间戳；点句可就地编辑 | 实时出字；编辑后保留时间戳；断线有显式提示与降级入口 |
| M4 | 转写解析 | 说话人标签解析 + Q&A 切分 | 输入带「面试官：/ 我：」的稿 → 正确切分；无标签时启发式切分成功率 ≥80%（用内置样例 `sample.json` 测） |
| M5 | 规则诊断 | 10 条规则，见 §10 | 每条诊断可展开显示：规则名 + 命中原话 + 字符区间 + 建议；无原话可指认的结论不得产出 |
| M6 | 观点层解析 | 观点卡对照 + 四维评分 + 改进话术 | 每条评分带 ≥1 个 `[S编号]`；无锚点结论被丢弃且 `droppedByValidator>0` 时 UI 标注"已过滤无依据结论" |
| M7 | 三方对照 | 你的回答 / 主流观点 / 分歧 并排 | 观点卡可点开跳转到原知乎链接 |
| M8 | 陪练会话 | 提问 + 连续追问（≤3 层）+ 追问点取自观点卡分歧 | 单题总追问轮次 ≤3；模型失败自动降级并提示 |
| M9 | 答辩预测 | 材料解析 + 预测提问（挂知乎质疑）+ 预答辩报告 | 上传论文 → ≤30 秒出 8–12 问 + 3 个高危点；≥2 问挂知乎质疑链接；报告可导出 Markdown |
| M10 | 讲解引擎 | 详解 + 就地追问 + 延伸检索 + 引用校验 | 详解每段带 ≥1 个引用；追问回答带依据强度标签；检索无果时 `noEvidence:true` 且不编造；延伸清单每条含链接 |
| M11 | 回流与台账 | 薄弱点 → 弹药库 → 优先复习 → 生成下一题 | 标记「已挂」并勾归因后，相关条目出现在「优先复习」置顶 |
| M12 | 降级与配额 | 熔断、缓存、预算、显式提示 | 断网/超配额时仍能跑通规则层；所有降级都有可见提示 |

### §10 规则表（规则层，10 条）

| # | ruleId | 检测方式 | 级别 |
|---|---|---|---|
| 1 | `followup_unresolved` | 同一问题被连续追问且答案未覆盖追问焦点 | red |
| 2 | `no_metric` | 回答中具体数字/指标数量 = 0 | red |
| 3 | `metric_no_baseline` | 给了数字但未说明口径/基线 | amber |
| 4 | `star_missing` | 情境/任务/行动/结果 四要素命中 < 3 | red |
| 5 | `we_not_i` | 「我们」次数 > 「我」 | amber |
| 6 | `vague_time` | 出现「之前/一段时间/后来/之后」等无锚点时间词 | amber |
| 7 | `off_topic` | 问题关键词在回答中的覆盖率 < 阈值 | red |
| 8 | `filler_density` | 嗯/啊/那个/就是/然后 每百字计数超阈值 | amber |
| 9 | `length_mismatch` | 回答字数与题型期望区间不符 | amber |
| 10 | `no_restate` | 回答前 20 字未复述/确认问题 | amber |

---

## 11. 前端规格

| 屏 | 内容 | 状态机 |
|---|---|---|
| 首页 / 题库 | 一句话定位 + 一键体验 + 题库筛选（赛道/难度/来源）+ 今日热榜话题 | `idle → loading → ready / empty / error` |
| 陪练室 | 题目卡 + 观点卡预览 + 答题区（打字/录音/字幕）+ 追问流 | `choosing → recording → parsing → answered` |
| 复盘台 | 三方对照 + 诊断列表（可展开）+ 改进话术 + 回流按钮 | `ready → expanded → archived` |
| 台账 | 机会/答辩状态机 + 每场下钻 + 归因 + 优先复习队列 | 12 态沿用 AfterAnswer 定义 |
| 讲解室 | 上传 → 详解（引用 chip）→ 追问 → 延伸 → 存薄弱点 | `upload → parsing → explained → asking → extended` |

视觉与体验要求：
- 首屏可交互 ≤ 1.5s（本地静态）；移动端窄屏可用（≥360px 宽）；键盘可达；对比度符合 WCAG AA；
- 加载态、空态、错误态、降级态四态齐全，**任何降级都有可见文案**；
- 引用 chip 统一视觉（文档页码 / 时间戳 / 知乎链接三种样式），点击可展开原文片段对照；
- 不使用任何未授权第三方素材；刘看山 IP 若使用，仅在作品展示位，且不作为主视觉。

---

## 12. 安全与隐私

| 项 | 要求 |
|---|---|
| 密钥 | 仅服务端环境变量；不进源码 / URL / 日志 / 前端响应 / 截图 / 演示视频 |
| 用户内容 | 录音、转写稿、答题记录、答辩材料 **全部只在用户浏览器 IndexedDB**；服务端不落用户内容（仅缓存公开知乎内容与跑批产物） |
| 导出 | 一键导出 JSON（可自证"数据在你手上"），导入可还原 |
| 第三方 | 仅调用知乎官方开放能力与所选模型服务；不接第三方追踪、不埋点 |
| API 规范 | 禁止批量高频调用发布类接口；本作品为只读检索 + 本地生成，不做内容发布 |
| 提交前 | grep 自查密钥；演示账号与个人账号不复用 |

---

## 13. 配额与降级策略

| 场景 | 预算 | 超限行为 | 降级链 |
|---|---|---|---|
| 站内/全网搜索 | 线上 ≤30/天 | 返回 `ZH_QUOTA_EXHAUSTED` | 本地题库 → 只出规则层 |
| 直答 | 单用户 ≤5/天，全站 ≤80/天 | 429 | 规则层 + 模板追问句 |
| 热榜 | 1 次/天 | 缓存 | 昨日榜单 |
| LLM | 20s 超时 | `LLM_TIMEOUT` | 规则层（前端显式提示） |
| 上游连续失败 | 连续 5 次 | 熔断 60s | 缓存数据 |

---

## 14. 验收清单（Given / When / Then，提交前逐条跑）

| # | Given | When | Then |
|---|---|---|---|
| A1 | 已登录态访问首页 | 打开站点 | ≤1.5s 内看到定位与体验入口，无控制台报错 |
| A2 | 在陪练室 | 录 20 秒并停止 | 有录音可回放，字幕有句子与时间戳，无上传请求 |
| A3 | 导入带说话人标签的样例转写 | 点击解析 | 正确切出 Q&A，每题有 ≥1 条可展开诊断且能定位原话 |
| A4 | 解析完成 | 查看诊断 | 每条含规则名 + 原话 + 建议；观点层结论带 `[S编号]` 且可点开来源 |
| A5 | 模型不可用（断网/超时） | 触发解析 | 界面明确提示"已切换规则模式"，规则层结论照常输出 |
| A6 | 上传论文 PDF | 生成预测提问 | ≤30s 得到 8–12 问 + 3 个高危点，≥2 问挂知乎质疑链接 |
| A7 | 上传 md 文档 | 生成详解 | 每段带引用 chip（页码/章节），点 chip 可定位原文 |
| A8 | 对某段提问且检索无果 | 查看回答 | 显示"未检索到直接依据"与建议检索词，**不出现编造的答案** |
| A9 | 标记「已挂」并勾归因 | 查看弹药库 | 相关条目置顶于「优先复习」，可一键生成练习题 |
| A10 | 窄屏 375px | 浏览五屏 | 无横向滚动，主要操作可达 |
| A11 | 断网 | 打开站点 | 静态资源与题库仍可用（缓存），接口错误有显式提示 |
| A12 | 全站搜索 | grep 密钥 | 源码/前端产物/日志中无 Secret、无明文 API Key |
| A13 | 想法链接 | 建队表单 | 校验通过（须含 `www.zhihu.com/pin`） |
| A14 | 提报当天 | 走 9 条提交自查 | 全部通过，无 Mock 占位冒充最终交付 |

---

## 15. 里程碑与 Definition of Done

| 里程碑 | 日期 | DoD |
|---|---|---|
| M0 骨架 | 11/19 | 仓库可 `pnpm dev` 起来；`/api/health` 返回配置状态；知乎搜索跑通一次并落 `question-bank.json` ≥500 题 |
| M1 录音解析 | 11/24 | A2–A5 通过（录音/字幕/切分/规则层/降级） |
| M2 陪练闭环 | 11/26 | A3、A9 通过；三方对照与观点层可演示 |
| M3 答辩 + 讲解 | 11/29 | A6–A8 通过；预答辩报告可导出 |
| M4 打磨 | 12/03 | A1、A10、A11 通过；计划书 v1 与演示视频完成 |
| M5 提报 | 12/05–12/06 | A12–A14 通过；作品已提报；想法运营已启动 |

---

## 16. 待你决策（我按默认值推进，但你可以改）

| # | 问题 | 我的默认 |
|---|---|---|
| Q1 | 模型服务用哪家 API（minimax / opencode go / 其他）？需要 base_url + 模型名 + key 形态 | minimax 优先，配 opencode go 兜底；你把配置写进 `.env` |
| Q2 | 部署平台：CloudBase 云托管 / Vercel / 其他 | CloudBase（官方 FAQ 推荐，免运维）；若你有现成云主机就用它 |
| Q3 | OAuth（登录 + 收藏/关注）做不做 | **默认不做**；12.05 拿到 App ID/App Key 且时间有余再评估（不影响 P0/P1） |
| Q4 | 是否拉队友 | 建议拉 1 人（决赛 Q&A + 传播 + 夜间并行开发），你在官方群找；**队名已定为「菜菜队」，队长不可变更，所以你若要换人当队长需要重建成队** |
| Q5 | 静态站与 BFF 是否同域单服务部署 | 是（规避 CORS，部署最简） |
| Q6 | 题库规模 | 500–800 题；跑批时间控制在 30 分钟内、可断点续跑 |
| Q7 | 想法标题/正文是否已定稿 | 已定稿并发布（`https://www.zhihu.com/pin/2105755975013746278`） |

---

## 17. 审批

- [ ] 我确认 SDD v0.1 内容（范围、模块、接口、验收、排期）
- [ ] 确认 Q1–Q7 的取值（可只回复"按默认"）
- [ ] 授权开始写代码（先 V0 骨架）
- [ ] 补充：Access Secret 由我在 `developer.zhihu.com/profile` 生成后写入 `apps/../.env`（不经过对话）

**任何范围变更先改本文档，再改代码。**
