# 知面陪练（ZhiMian Coach）· 知乎黑客松 S3（菜菜队）

> 锚定知乎多元观点的 AI 面试与答辩陪练教练：**读懂资料 → 开口说清 → 被追问压力测试 → 查清楚来源**。

赛道：AI × 陪伴与交互 ｜ 交付形态：公网 Web（主）+ PWA / Windows 桌面（选交）
想法：<https://www.zhihu.com/pin/2105755975013746278> ｜ 队名：菜菜知面

---

## 目录结构

```
apps/web/            零构建原生 ES Modules 静态前端
  index.html         单页壳（topbar / degraded banner / screen-root / citation modal / toast）
  styles/app.css     设计系统（颜色变量、卡片、标签、引用 chip、骨架屏）
  js/router.js       hash 路由（#/bank #/coach #/review #/explain #/ledger）
  js/state.js        全局状态 + 题库加载 + 后端健康探测（失败即显式降级）
  js/db.js           IndexedDB（sessions / weaknesses / opportunities）+ 导入导出
  js/screens/        bank / coach / review / explain / ledger 五个屏
  js/capture/        recorder（MediaRecorder）/ caption（Web Speech）/ transcript（说话人切分）
  js/rules/          10 条确定性规则 + 聚合（每条带原话 + 字符区间）
  js/retrieval/      BM25 检索（中文二元组切词）+ 文档切块
  js/ui/             citation chip + 弹窗、viewpoint card、toast
  data/question-bank.json   真题库（构建产物，随站发布）
apps/bff/            Node 20 + TypeScript + Hono（同域托管静态资源与 /api）
  src/index.ts       路由挂载 + 静态服务
  src/lib/           zhihuClient / llm / citations（防编造校验）/ cache / quota / docParser / prompts
  src/routes/        zhihu / coach / explain / auth / asr
  dist/              tsc 产物（生产用 `node dist/index.js`，不再需要 tsx）
scripts/build-bank/  离线跑批：questions.mjs（真题）→ cards.mjs（观点卡）→ to-v02.mjs（schema 转换）
docs / *.md          规划与规格（PLAN / sdd_v0_2 / 作品稿 / 想法 / 小红书 / 开发日志）
```

---

## 快速启动

```bash
pnpm install                       # 首次
cp .env.example .env               # 填 ZHIHU_ACCESS_SECRET / LLM_BASE_URL / LLM_API_KEY / LLM_MODEL
pnpm dev -- --port 8788            # 开发（tsx，热重载）
# 或生产形态：
pnpm build:bff && PORT=8788 pnpm start
```

环境变量：`ZHIHU_ACCESS_SECRET`（知乎开放平台）、`LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL`（OpenAI 兼容，当前用 DeepSeek `deepseek-v4-flash`）、`PORT`。
**未配置密钥时服务仍可启动**：自动降级为本地题库 + 10 条规则引擎，并在页面顶部显示显式降级横幅。

---

## 数据来源（真实，不是示例）

| 环节 | 接口 | 说明 |
|---|---|---|
| 真题 | `GET /api/v1/user/question_recommendations` | 真人问题（Title + Url）；搜索接口返回的多是专栏文章，**不能当题** |
| 来源 | `GET /api/v1/content/question_answers` | 高赞回答 `Summary/Url/ContentToken`；**接口不返回赞同数与作者**，前端因此不显示赞数 |
| 观点卡 | `POST /v1/chat/completions`（`zhida-fast-1p5`） | 生成立场/摘要/证据句；**证据句逐字校验**，不通过则重试或标 `evidenceVerified=false` |
| 评分 | OpenAI 兼容模型（DeepSeek） | 四维评分 + 追问 + 改进话术，每条结论强制 `refIds`，越界即丢弃并计数 |

当前库内：**38 题 / 15 题带观点卡 / 56 张卡**（`data-raw-bank.json` 为原始跑批产物，`apps/web/data/question-bank.json` 为前端契约格式）。

---

## 防编造（工程，不是文案）

1. 模型只能引用给定来源集合 `S1..Sn`；
2. 后处理校验 `refIds` 是否全部合法，越界或非推断类缺引用 → **整条丢弃并计数**；
3. `basis` 枚举强校验：模型把理由塞进 `basis` 时，带合法引用则规范化为「外部佐证」并转存 `inferenceReason`，无引用则丢弃；
4. 失败必显式：模型/接口异常 → `degraded=true` + 页面横幅 + 规则层结论照常输出。

---

## 测试与验证（手工跑通的部分）

- 首页 → 一键体验 → 复盘台（三方对照 + 7 条原话诊断 + AI 观点层 4 卡 10 个引用 chip）
- 陪练室 → 填入样例 → 生成复盘（模型链路 17–24s，超时上限 25s）
- 陪练室 → 触发追问 ×2（客户端 3 轮上限，追问取自知乎分歧观点）
- `/api/health` 返回 `{ok, zhihuConfigured, llmConfigured, bankSize}`
- `tsc --noEmit` 通过；`tsc -p` 产物可用 `node dist/index.js` 独立启动

---

## 已知边界（诚实标注）

- 录音需 https/localhost（`getUserMedia` 安全上下文约束）；自动化环境未能验证真实麦克风，需真人点一次。
- 实时字幕依赖 Web Speech API：Edge 走 Azure 较稳，Chrome 国内不稳；WebView2/桌面壳不提供。
- `question_answers` 无赞同数 → 观点卡显示「知乎答主」而非虚构赞数。
- 讲解室（PDF/md 详解 + 追问）已接路由，尚未做端到端验证。
