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
                    一条命令：`pnpm bank:full`（可加 --limit / --delay 控制配额与限流）
docs / *.md          规划与规格（PLAN / sdd_v0_2 / 作品稿 / 想法 / 小红书 / 开发日志）
```

---

## 部署（单容器）

```bash
docker build -t zhimian-coach .
docker run -d --rm -p 8787:8787 --env-file .env -v "$PWD/.cache:/data/.cache" \
  -e CACHE_PERSIST=1 -e CACHE_DIR=/data/.cache zhimian-coach
```

- 生产阶段不需要 `tsx`：镜像内 `pnpm --filter @zhimian/bff build` 后直接 `node apps/bff/dist/index.js`
- 同域托管静态站点 → 规避 CORS，且容器平台分配的 HTTPS 域名满足录音（`getUserMedia`）的安全上下文要求
- **缓存落盘**：`CACHE_PERSIST=1` + `CACHE_DIR` 指向**挂载卷**才有意义；容器文件系统是临时的，不挂卷重启即丢
- 未挂卷时退化为纯内存缓存，功能不受影响，只是重启后重新消耗知乎配额

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

## 录音与实时字幕（M2 / M3）

**同时开着飞书 / 腾讯会议时录音会失效吗？**
一般不会 —— Windows 音频是共享模式，多个应用可同时打开麦克风。但有 4 类真实故障，都会导致"录到静音却不报错"：
1. 会议软件把**默认输入**切成它的虚拟设备（腾讯会议/飞书虚拟麦克风）；
2. 声卡驱动开了**独占模式**（专业声卡常见）→ `getUserMedia` 失败或静音；
3. 蓝牙耳机切到 HFP 通话档 → 采样率降到 8/16k，音质变差但不断流；
4. 会议软件改写增益/降噪 → 声音变小。

因此陪练室做了四道保护：
- **输入设备下拉 + 刷新**：显式指定麦克风，绕过"默认输入被切走"；
- **实时音量条 + dB 读数**；
- **连续 4 秒低于 -50dB 的静音告警**（页面红字 + toast，点明"可能被会议软件占用"）；
- 录音只存本机 IndexedDB，可回放确认。

**PDF 解析（三级，先测质量再升级）**
| 引擎 | 何时用 | 本机可用性 |
|---|---|---|
| `pdf-parse` | 默认；有文本层的 PDF | ✅ |
| `local-ocr`（PyMuPDF + RapidOCR） | `pdf-parse` 抽出的文本质量低于 70 分（扫描件常得 0 字） | ✅ 本机有依赖；容器里没有 → 自动跳过 |
| Apache Tika | 配 `TIKA_URL`（自建 `docker run -p 9998:9998 apache/tika`） | 需自建 |
| MinerU | 配 `MINERU_URL`（自建服务） | 需自建 |

质量评估看的是可量化指标：汉字间空格比、乱码率、控制字符、行均长度、重复行比例 —— 前端会显示「用了哪个引擎 + 质量问题」，不把烂文本当真。
实测：图片版 PDF `pdf-parse` 得 **0 字 / 45 分** → 本地 OCR 兜底 **2798 字 / 100 分**。

**陪练室三种练法（可切换，各自记住上次的题）**

| 练法 | 题目来自 | 评分基准 | 适用 |
|---|---|---|---|
| **📚 真题陪练** | 知乎真题库（53 题，38 题带观点卡） | 知乎高赞观点卡（主流 + 分歧） | 练通用高频题、看知乎怎么答 |
| **🧾 简历陪练** | 你上传的简历（PDF/MD/TXT） | **面经来源（知乎真实内容）+ 规则层 10 条** | 让面试官追着你自己的项目问 |
| **🎙 录音复盘** | 本机录音 / 会议转写稿（导入或粘贴） | 规则层 10 条（未绑定题目来源，不跑观点层，界面明说） | 把已经发生的一场对话变成可核对的复盘 |

**录音复盘模块**（与前两种练法解耦，右栏独立）：
设备选择 → 录音 + 实时字幕（可就地编辑/补写、说话人徽标可点改）→ 可选双轨（麦克风=我 / 系统声音=面试官）→ 转写（字幕整理 / 会议转写稿导入 / 双轨导出 + 本机转写脚本）→ **生成录音复盘报告**（0.5s，逐题规则诊断 + 原话定位）。
转写稿可一键「带入」真题/简历陪练的作答框。

**简历陪练**：上传简历 → 抽取 `画像 / 技能 / 项目 / 缺口` → 生成 6–10 道题，**每题挂简历定位符**（`p1¶14`）+ 2–3 条真实面经来源。
- 面经来源同时充当观点层依据：提交回答后，四维评分里的每条结论都带 `[S]` 编号，可点开看面经原文（和真题模式同一套引用校验）
- **结果缓存**：按简历内容哈希缓存 7 天，同一份简历第二次分析 **0.1s 返回**（`cached:true`）；旁边「重新出题」可强制忽略缓存
接地校验：locator 不在简历分段里的题直接丢弃（`droppedByGrounding` 计数），不做"凭空编经历"的题。
简历题**不跑观点层**（没有对应观点卡），只跑规则层 10 条 + 面经参考 —— 界面上明说，避免拿无关观点硬套。

**说话人分离（面试官 / 我）**
- 推荐姿势：**双轨采集** —— 麦克风（我）+「同时录系统声音」（面试官），各自成轨，天然分离。
  勾选后会弹共享选择器，**必须勾"分享音频"**，否则会明确报错而不是静默。
- 实时字幕只能吃浏览器默认输入（Web Speech API 不接受自定义 MediaStream），所以字幕的说话人靠：
  - **手动模式（推荐）**：「我说 / 面试官说」一键切换，后续句子按此归人；
  - **自动模式**：按问句特征、人称词、上一句说话人推断，可能不准 —— 每句都带徽标，点一下即可改成正确的人；
  - 「字幕整理成转写稿」→ 输出 `面试官：… / 我：…`，直接喂给复盘解析。
- 不支持 `getDisplayMedia` 的环境（移动端 / Tauri 桌面壳）会自动禁用双轨并给出提示。

**双轨 → 复盘（转写两条路线）**
1. 页面「转写这两轨」：调 `/api/asr/status`；配了云端 ASR（`ASR_PROVIDER` + `ASR_BASE_URL` + `ASR_API_KEY`）就直接转，两轨分别转写后按时间轴合并成 `面试官：… / 我：…`。
2. 未配置时**不会假装能转**：返回 501 + 明确指引 —— 点「导出两条音轨」，然后在本机跑
   ```bash
   node scripts/asr/local-transcribe.mjs mic.webm system.webm   # 可选 --with-time
   ```
   本机 faster-whisper 转写两轨 → `ffmpeg silencedetect` 校正说话起点偏移 → 同一套 `align.js` 按时间轴合并 → 生成 `transcript.txt`，粘回作答框即可生成复盘。

## 已知边界（诚实标注）

- 录音需 https/localhost（`getUserMedia` 安全上下文约束）；自动化环境未能验证真实麦克风，需真人点一次。
- 实时字幕依赖 Web Speech API：Edge 走 Azure 较稳，Chrome 国内不稳；WebView2/桌面壳不提供。
- `question_answers` 无赞同数 → 观点卡显示「知乎答主」而非虚构赞数。
- 讲解室已端到端验证（上传→分段→BM25 检索→模型仅依据片段作答→引用 chip→无依据显式兜底）。
  **PDF 支持**：`.pdf` 走 BFF 逐页解析（`p{页码}¶{段号}` 定位符），自动折叠中文汉字间空格；扫描件（无文本层）会明确报错，不假装解析成功。
- **答辩预测**契约：`POST /api/defense/analyze {title, segments}` → `{degraded, topRisks[], predictedQuestions[{q, why, zhihuRef}]}`；知乎质疑检索失败时 `degraded:true` 且不伪造引用。
- **单元测试**：`pnpm test`（7 条：规则、转写切分、时间戳容忍、双轨对齐、引用校验）。
