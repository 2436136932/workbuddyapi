# workbuddyapi

把 **WorkBuddy / CodeBuddy 账号额度（国内版 + 国际版）** 包装成本机上的
**OpenAI 兼容 + Anthropic 兼容** 接口，供 **TraeWork / TRAE / TraeCode CLI / Cherry Studio / Cursor** 等
任意 OpenAI 兼容客户端当作「自定义模型」接入。

> Turn your WorkBuddy (Tencent CodeBuddy) account quota — **both the China and the international
> edition** — into a local, OpenAI- and Anthropic-compatible HTTP endpoint.
> Zero dependencies, pure Node.js, loopback-only.

- 依赖：仅需 **Node.js ≥ 20.11**（`import.meta.dirname` 需要，推荐 22 LTS），**零第三方依赖**，不用 npm install、不用 Docker。
- 隔离：配置 / 凭证 / 统计 / 审计 / 日志全部落在**项目内的 `data/` 目录**；登录走官方**设备授权（OAuth）**，
  不读取 WorkBuddy 客户端的本地配置、浏览器数据或任何项目目录以外的文件。
- 监听：默认只绑 `127.0.0.1:8788`，不对局域网/公网暴露，带本地 API Key 鉴权。
- 多站点：国内版（`copilot.tencent.com`）与国际版（`codebuddy.ai` / `workbuddy.ai`）协议同构，
  一套服务同时代理、按模型自动路由；两边额度互不通用，各自登录。
- 能力：流式 / 非流式、完整工具调用（tool_calls 流式聚合、多轮回灌）、
  `developer` 角色与 `tool_choice` 归一、accessToken 临期自动刷新、上游并发限制与失败退避重试、
  元数据接口超时兜底、来源（Origin）安全校验。
- **积分组成与到期时间**：把上游每个「套餐包」的剩余量、类型、周期结束时间与**真正失效时刻**逐条列出，
  汇总成「积分由哪几部分组成」，并对 30 天内到期的额度给出提醒。
- **监控与统计**：延迟分位（P50/P90/P95/P99）、24 小时分布、按站点 / 按密钥 / 按模型拆分、
  `/metrics`（Prometheus 文本格式）、CSV 导出。
- **访问控制**：多密钥（SHA-256 哈希存储，明文只显示一次）、按密钥限制**可用站点 / 可用模型（支持前缀通配）**、
  RPM 与并发限流、每日调用与 credit 配额、来源 IP 白名单（含 CIDR）、访问审计（落盘 `data/audit.log`）。
- **账号一眼可辨**：每个站点卡片显示**账号昵称、完整 UID、企业 ID、登录时间**，并支持给账号设**备注名**
  （同一站点下挂了多个账号时尤其有用）。
- **主密钥可在网页里改**：控制台「总览 → API 密钥 → 修改」可直接自定义或一键随机生成，改完立即生效。
- **苹果风格控制台**：macOS 观感的毛玻璃材质、圆角卡片、iOS 分段控件与开关，**明暗双主题**（跟随系统 / 手动切换并记忆）。

---

## 1. 目录结构

```
workbuddyapi/
├── server.mjs            # 服务入口（路由 + 鉴权 + 限流 + 路径容错 + /metrics + 控制台挂载）
├── console-open.mjs      # 打开控制台窗口（服务没启动会自动拉起）
├── console-open.vbs      # 隐藏窗口调用上面那个（桌面快捷方式用）
├── login.mjs             # 设备授权登录（--site 选站点），凭证写入 data/auth.<站点>.json
├── status.mjs            # 查看各站点登录状态 + 剩余积分 + 积分组成与到期时间
├── checkin.mjs           # 一键签到（--claim 领取 / --growth 含成长中心 / --site 选站点）
├── checkin.cmd           # 双击一键签到（全部已登录站点）
├── checkin-install.cmd   # 注册 Windows 计划任务（每天 09:10 自动签到）
├── checkin-scheduled.cmd # 计划任务实际执行脚本（静默，结果进 data/checkin.log）
├── ask.mjs               # 命令行提问客户端（验证代理是否正常）
├── stop.mjs              # 通过 /admin/shutdown 优雅停止服务
├── start.cmd             # 双击启动（前台，带日志）
├── start-hidden.cmd      # 双击启动（最小化窗口，后台常驻）
├── start-hidden.vbs      # 完全隐藏启动（桌面「启动反代」快捷方式用）
├── stop.cmd / status.cmd / login.cmd / login-intl.cmd / ask.cmd
├── config.example.json   # 配置样例（复制为 data/config.json 后按需修改）
├── smoke.mjs             # 端到端冒烟测试（npm run smoke；独立数据目录 + 空闲端口）
├── package.json          # 元信息与脚本（零依赖，无需 npm install；engines: Node ≥ 20.11）
├── LICENSE               # MIT
├── data/                 # ★ 所有运行时数据（自动创建，已被 .gitignore 忽略）
│   ├── config.json       #   主配置（含本地 API Key）
│   ├── auth.<站点>.json   #   各站点 / 账号槽位凭证
│   ├── keys.json         #   访问密钥（多密钥、SHA-256 哈希存储、作用域与限流）
│   ├── usage.json        #   用量统计（按天/小时/站点/模型/密钥）
│   ├── checkin.json      #   签到记录 + 自动签到开关
│   ├── audit.log         #   访问审计（JSONL，每次请求与拒绝原因）
│   └── server.log 等      #   运行日志
├── console/
│   └── index.html        # 控制台界面（单文件、零依赖、苹果风格、明暗双主题）
├── test/                 # node:test 单元测试（node --test / npm test）
│   ├── cors.test.mjs
│   ├── router.test.mjs
│   ├── upstream.test.mjs
│   ├── checkin.test.mjs
│   ├── anthropic.test.mjs
│   ├── access.test.mjs   #   访问控制（哈希/作用域/限流/配额/IP 白名单）
│   ├── credit.test.mjs   #   积分组成与到期时间解析
│   └── paths.test.mjs    #   data/ 目录布局与防路径穿越
└── src/
    ├── config.mjs        # 配置加载 + 站点表 + data/ 路径与旧文件自动迁移 + 环境变量覆盖
    ├── auth.mjs          # 多站点凭证存取 + 自动刷新（单飞）+ 运行中热加载
    ├── device-login.mjs  # 设备授权登录（CLI 与控制台共用）
    ├── headers.mjs       # 站点感知的上游请求头
    ├── upstream.mjs      # 上游聊天/模型/额度接口 + SSE 解析
    ├── checkin.mjs       # 一键签到 + 成长中心（签到状态/领取/旅行/任务/补登/兑换/抽奖/盲盒）
    ├── auto-checkin.mjs  # 自动签到开关 + 定时触发 + 签到记录（落盘 data/checkin.json）
    ├── router.mjs        # 模型 → 站点 路由（default 别名 / 前缀 / 路由表 / 目录并发匹配 + 目录缓存）
    ├── openai.mjs        # /v1/models、/v1/chat/completions
    ├── anthropic.mjs     # /v1/messages、/v1/messages/count_tokens
    ├── console-api.mjs   # 控制台后端接口（状态/模型/积分/监控/密钥/审计/用量/探测/登录/停服）
    ├── access.mjs        # 访问控制（多密钥哈希/作用域/令牌桶限流/每日配额/IP 白名单/审计）
    ├── credit.mjs        # 积分组成与到期时间（套餐包规范化、汇总、到期提醒）
    ├── metrics.mjs       # Prometheus 指标导出（/metrics 文本格式）
    ├── usage.mjs         # 用量与监控统计（延迟分位/小时分布/按站点与密钥，落盘 data/usage.json）
    ├── cors.mjs          # 浏览器来源（Origin）判定
    ├── util.mjs          # HTTP/SSE 小工具（含带超时的 fetch）
    └── log.mjs           # 日志（含内存环形缓冲，供控制台实时查看）
```

**数据目录**：所有运行时数据都在 `data/` 下，项目根目录只保留代码与文档。
旧版本（v1.2 之前）散落在根目录的 `config.json` / `auth.*.json` / `usage.json` / `checkin.json` / `*.log`
会在**首次启动时自动迁移**进 `data/`（只移动、不覆盖已有数据、不删除内容）。
数据目录可用环境变量 `WB_DATA_DIR` 指到别处（便于测试或多实例隔离）。

启动后会打印每个站点的登录状态：

```
站点 cn-cli    已登录 uid=xxxxxxxx…   https://copilot.tencent.com
站点 intl-cli  未登录                 https://www.codebuddy.ai
站点 intl-work 未登录                 https://www.workbuddy.ai
未登录的站点可用：node login.mjs --site <站点名>
```

---

## 2. 启动 / 停止服务

```powershell
node server.mjs          # 前台运行（日志直接打在终端，Ctrl+C 停止）
```

双击脚本更省事：

| 脚本 | 作用 |
|---|---|
| **桌面「WorkBuddy 控制台」快捷方式** | 打开控制台独立窗口（服务没启动会自动拉起） |
| `console-open.vbs` / `console-open.mjs` | 同上（命令行版）：静默启动服务 → 用 Edge 应用模式开无地址栏窗口 |
| `start.cmd` | 前台启动（带日志，关窗口即停） |
| `start-hidden.cmd` | 后台最小化启动 |
| `start-hidden.vbs` | 完全隐藏启动，日志写入 `data/server.log`（桌面「启动 WorkBuddy 反代」快捷方式用的就是它） |
| `stop.cmd` | 停止服务（调 `/admin/shutdown`，不依赖 WMI/进程枚举） |
| `status.cmd` | 查看各站点登录态 + 剩余积分 |
| `checkin.cmd` | 一键签到（全部已登录站点；`node checkin.mjs --growth` 含成长中心全量） |
| `checkin-install.cmd` | 注册 Windows 计划任务（每天 09:10 自动签到，服务没启动也能跑） |
| `ask.cmd` / `ask.mjs` | 命令行提问，用来验证代理是否正常 |
| `login.cmd` / `login-intl.cmd` | 登录国内版 / 选择国际版站点 |

启动后终端会打印：

```
WorkBuddy 反代已启动（国内版 + 国际版多站点）v1.2.0
  控制台：http://127.0.0.1:8788/console   ← 建议用桌面快捷方式打开
  监听地址：http://127.0.0.1:8788   （仅本机可达）
  API Key：123456
  数据目录：E:\workbuddy-openai-proxy-main\data
  默认站点/模型：cn-cli / deepseek-v4-pro    配置文件：…\data\config.json
  站点 cn-cli    已登录 uid=xxxxxxxx…   https://copilot.tencent.com
  站点 intl-cli  已登录 uid=xxxxxxxx…   https://www.codebuddy.ai
  站点 intl-work 未登录                 https://www.workbuddy.ai
  OpenAI 客户端：Base URL = http://127.0.0.1:8788/v1
  监控指标：http://127.0.0.1:8788/metrics（Prometheus 文本格式）
  自动签到：未开启（控制台「签到」里可开，或运行 node checkin.mjs）
```

> **Key 与 URL 只需填一次**：它们保存在 `data/config.json` 里，重启服务/重启电脑都不变；
> 只有删掉 `data/config.json`（会重新随机生成 Key）或改 `port`（URL 会变）才需要重新填。

自检：

```powershell
status.cmd                              # 各站点登录态 + 剩余积分
node ask.mjs --list                     # 列出全部模型（含站点与积分倍率）
node ask.mjs claude-sonnet-4.6 "你好"    # 直接提问，会显示是哪个站点接的
```

---

## 3. 控制台（苹果风格的一体化管理界面）

双击桌面「**WorkBuddy 控制台**」快捷方式即可：服务没启动会**自动静默拉起**，然后用 Edge 的
**应用模式**打开一个**无地址栏的独立窗口**（看起来就是个桌面客户端）。也可以直接访问
`http://127.0.0.1:8788/console`。

界面按 macOS 观感设计：系统字体栈（SF Pro / 苹方）、毛玻璃材质、圆角卡片、柔和阴影、
iOS 分段控件导航与开关。右上角 **◐** 按钮循环切换 **跟随系统 / 亮色 / 暗色**，选择会记住。

| 页签 | 能做什么 |
|---|---|
| **总览** | 各站点**账号身份**（昵称 / 完整 UID / 企业 ID）、登录态、剩余积分、积分构成包数、**最近到期提醒**、可用模型数、token 到期；Agent 该填的 URL 与**可在线修改的主密钥**；给账号设备注名 |
| **积分** | ★ 每个站点一张卡：剩余 / 总额度 / 已用 / 最后失效时间、**积分组成堆叠条**（按套餐包占比着色 + 图例）、逐包明细表（剩余 / 总量 / 已用 / 周期结束 / **到期时间** / 剩余时长），并按到期先后排序；顶部对 30 天内到期的额度给出提醒条 |
| **监控** | 运行时长 / 内存、累计调用与失败率、**延迟分位（P50/P90/P95/P99 + 最大）**、24 小时调用分布柱状图、按站点 / 按访问密钥 / 按模型延迟三张表 |
| **模型** | 列出全部站点模型（标注积分倍率、`免费` 徽章），点「设为默认」即完成切换；支持搜索、按站点筛选、只看免费、隐藏站点副本 / 未登录清单、批量探测可用性 |
| **用量** | 今日 / 累计调用次数、token、credit 消耗；最近 7 天柱状图；按模型排行（可按消耗 / 调用 / 失败 / Token / 延迟排序）；**导出 CSV**；可一键清空 |
| **签到** | 各站点签到状态、一键领取今日签到、签到 + 成长中心全量（旅行/任务/补登/兑换/抽奖/盲盒）、自动签到开关 |
| **访问控制** | ★ 新建受限密钥（站点 / 模型白名单、RPM、并发、每日配额）、密钥列表（掩码显示、启用停用、删除）、来源 IP 白名单、审计开关、**访问审计表**（可按失败 / 拒绝 / 磁盘历史过滤） |
| **日志** | 最近 500 条日志滚动刷新，请求日志按状态着色 |
| **账号** | 每个账号显示**昵称 / 槽位键 / UID / 企业 ID / 登录时间**，可设备注名；发起设备授权登录、退出登录、加号扩展账号池 |
| **服务** | 查看运行时长 / 版本 / 监听地址 / **数据目录** / 监控指标地址，一键停止服务 |

**账号区分**：同一站点（如 `cn-cli`）可以挂多个账号槽位（`cn-cli` / `cn-2` / `cn-3`…）。
每张卡片都以**账号昵称**为标题并列出完整 UID 便于核对；嫌昵称不好认可点「**设置备注名**」改成
「主力号 / 备用号」之类的名字（留空即恢复默认）。命令行 `status.cmd` 也会打印账号与 UID。

**主密钥在线修改**：总览页「API 密钥」旁点「**修改**」，可直接输入新密钥或点「**随机生成**」，
保存后立即生效（写入 `data/config.json`）——使用旧密钥的客户端会立刻 401，记得同步更新。
密钥短于 8 位会给出弱口令提醒但不阻止（默认值 `123456` 就属于这种情况）；留空则关闭鉴权（仅建议本机使用）。

安全性：控制台页面只监听本机；页面里注入的是**每次启动随机生成的会话令牌**（不是 `apiKey`），
控制台接口只认这个令牌或**主密钥**（受限密钥无权管理服务），错误令牌返回 401。控制台只读写 `data/` 内的文件。

---

## 3.1 积分组成与到期时间

上游的额度是按「套餐包」分别计费的，一个账号往往同时有十几个甚至几十个包（体验版、赠送包、
运营活动包…），**每个包有自己的剩余量和失效时间**，到期未用完就作废。本项目把它完整解析出来：

- 命令行：`status.cmd`（或 `node status.mjs`）会逐站点打印积分组成与到期时间，例如：

```
■ cn-cli  国内版 CLI（copilot.tencent.com）
    剩余积分：2340 credits  （共 2340，已用 0，24 个套餐包）
    积分组成：
      · CodeBuddy个人版国内运营裂变包  [一次性赠送]  1840 / 1840  (79%)  ×23  最近到期 2026-11-10（32 天）
      · CodeBuddy个人体验版           [周期订阅]   500 / 500  (21%)  ×1   最近到期 2034-10-13（8 年 4 天）
    ⚠ 最近将过期：CodeBuddy个人版国内运营裂变包  剩余 100，2026-10-14 到期（还有 4 天）
    最后失效时间：2034-10-13（8 年 4 天）
```

- 接口：`GET /status` 返回的 `credit` 字段含 `parts`（按套餐名聚合的组成）、`packages`（逐包明细）、
  `nextExpiry`（最近到期）、`lastExpiry`（最后失效）、`inactiveCount`（已失效包数）。
- 控制台：见上方「**积分**」页签。

字段口径（与上游一致）：

| 字段 | 含义 |
|---|---|
| `typeLabel` | `周期订阅`（每月重置，如体验版）/ `一次性赠送`（用完即止） |
| `cycleEnd` | 本计费周期的结束时间（周期性套餐的**本月重置**时间） |
| `deductionEnd` | 该包**真正失效**的时刻（一次性包的截止时间看这里） |
| `expiry` | 有效到期时间：优先 `deductionEnd`，其次上游 `ExpiredTime`，最后 `cycleEnd` |
| `status` | `0` = 有效；`3` = 已失效 / 已耗尽（不计入剩余合计，控制台以半透明行展示） |

---

## 3.2 监控与指标

- 控制台「**监控**」页签：延迟分位、24 小时分布、按站点 / 密钥 / 模型三张表。
- Prometheus：`GET /metrics`（需鉴权，文本格式 0.0.4），可用 `curl -H "Authorization: Bearer <apiKey>" http://127.0.0.1:8788/metrics` 查看。
  导出指标包括：

| 指标 | 类型 | 说明 |
|---|---|---|
| `workbuddy_up` / `workbuddy_uptime_seconds` / `workbuddy_build_info` | gauge | 存活、运行秒数、版本信息 |
| `workbuddy_site_logged_in{site}` | gauge | 各站点登录状态 |
| `workbuddy_requests_total{status}` | counter | 累计调用（ok / error） |
| `workbuddy_tokens_total{kind}` | counter | 输入 / 输出 token |
| `workbuddy_credit_used_total` | counter | 累计 credit 消耗 |
| `workbuddy_model_requests_total{model,site}` 等 | counter | 按模型 / 按站点的调用、失败、credit |
| `workbuddy_key_requests_total{key}` / `workbuddy_key_credit_used_total{key}` | counter | 按访问密钥的用量 |
| `workbuddy_request_duration_ms_bucket/sum/count` | histogram | 上游请求耗时直方图 |
| `workbuddy_latency_p50_ms` … `p99_ms` | gauge | 延迟分位（估算值，便于快速看板） |
| `workbuddy_key_inflight{key}` / `workbuddy_key_daily_calls{key}` | gauge | 当前在途、当日调用 |

- 统计口径：按**天**累计，另含 **24 小时分布**、**按站点**、**按访问密钥**、**按模型**（含延迟分位）。
  落盘 `data/usage.json`，重启不丢失；控制台「用量」页可**导出 CSV**。
- 关闭指标：`config.json` 的 `metrics.enabled = false`，或环境变量 `WB_METRICS=0`。

---

## 3.3 访问控制

主密钥（`config.json` 的 `apiKey`）拥有全部权限；此外可在控制台「**访问控制**」页签发**受限密钥**，
分给不同工具（TraeWork / Cursor / 脚本…）各用一个，互不影响、可单独吊销。

**密钥存储**：明文只在创建时返回一次，落盘 `data/keys.json` 只保存 **SHA-256 哈希**——
即使配置文件泄露也无法反推出密钥；忘记只能删除重建。

**每个密钥可限制**：

| 限制项 | 说明 |
|---|---|
| 可用站点 | 如 `intl-cli,cn-cli`；留空 = 不限 |
| 可用模型 | 支持前缀通配，如 `deepseek*`、`claude*`；留空 = 不限 |
| RPM | 每分钟请求上限（令牌桶），超出返回 429 |
| 并发 | 同时在途请求上限，超出返回 429 |
| 每日调用 | 每日调用次数上限，次日重置 |
| 每日 credit | 每日 credit 消耗上限，次日重置 |

**来源 IP 白名单**：`access.ipAllowList`（支持单个 IP 与 IPv4 CIDR，如 `192.168.1.0/24`），
留空表示不限制。服务默认只监听 `127.0.0.1`，一般无需设置。

**访问审计**：每次请求（含被拒绝的）都记一条，落盘 `data/audit.log`（JSONL），
控制台「访问审计」表可查看与过滤；拒绝原因包括 `rate_limited`、`site_not_allowed`、
`model_not_allowed`、`ip_not_allowed`、`invalid_api_key` 等。

被拒绝时的返回示例：

```json
{ "error": { "message": "该密钥无权访问模型 glm-5.3", "type": "model_not_allowed", "code": 403 } }
```

---

## 3.4 环境变量与数据目录

部署或容器化时可用 `WB_*` 环境变量覆盖配置（**优先级高于 `config.json`**）：

| 变量 | 作用 |
|---|---|
| `WB_DATA_DIR` | 数据目录（默认 `<项目>/data`），便于多实例隔离或放到挂载卷 |
| `WB_HOST` / `WB_PORT` | 监听地址与端口 |
| `WB_API_KEY` | 主密钥 |
| `WB_DEFAULT_SITE` / `WB_DEFAULT_MODEL` | 默认站点 / 模型 |
| `WB_MAX_TOKENS` | 默认最大输出 token |
| `WB_DEFAULT_SYSTEM_PROMPT` | 缺省 system 提示词 |
| `WB_CORS_ORIGINS` | 额外放行的跨站来源，逗号分隔 |
| `WB_IP_ALLOWLIST` | 来源 IP 白名单，逗号分隔 |
| `WB_METRICS` | `0` / `false` / `off` 关闭 `/metrics` |

---


## 4. TraeWork 接入（桌面版）

> 官方限制：**仅 TraeWork 桌面版支持添加自定义模型**，且自定义模型**只在本地环境可用**。

**设置 → 模型 → 添加模型 → 选择「自定义模型」**，按下表填写：

| 参数 | 填写值 |
|---|---|
| API 格式 | **OpenAI Chat Completions 格式**（推荐） |
| 自定义请求地址 | 打开 **完整 URL** 开关，填 `http://127.0.0.1:8788/v1/chat/completions` |
| 模型 ID | **`default`**（推荐，见下方说明）或任意具体模型 ID |
| 模型展示名称 | 例如 `WorkBuddy` |
| API 密钥 | `config.json` 里的 `apiKey` |

> **强烈建议模型 ID 填 `default`**：它是个虚拟模型，指向控制台里设置的「默认模型」。
> 以后想改用 Claude / GPT / GLM，只需在控制台点一下切换，**TraeWork 那边一个字都不用改**。
> 也可以用站点前缀强制指定，例如 `intl-cli/claude-sonnet-4.6`。

**高级配置**（建议）：

| 参数 | 建议值 |
|---|---|
| 模型系列 | 用 `deepseek-v4-pro` 选 **DeepSeek-4 系列**（自动开思考模式 + 推荐超参）；用 GLM/Kimi 选「默认」 |
| 上下文窗口 | 输入 `1000000`、输出 `65536`（可留空用默认） |
| 工具调用轮数 | 留空（用默认） |
| 支持图片输入 | 仅当模型支持视觉（如 `glm-5v-turbo`）才勾选 |
| 采样参数 | 留空即可 |

要改用 **Anthropic Messages 格式**（Claude 型）也可以：完整 URL 填 `http://127.0.0.1:8788/v1/messages`，其余字段同上。

**关于「完整 URL」开关**（两种填法都对，任选其一，别混用）：

| API 格式 | 打开「完整 URL」→ 填完整地址 | 关闭「完整 URL」→ 填基础地址（TraeWork 自己拼路径） |
|---|---|---|
| OpenAI Chat Completions | `http://127.0.0.1:8788/v1/chat/completions` | `http://127.0.0.1:8788/v1` |
| Anthropic Messages | `http://127.0.0.1:8788/v1/messages` | `http://127.0.0.1:8788/v1` |

> 服务端已做**路径后缀容错**：只要路径里含有 `/chat/completions`（按 OpenAI 处理）或 `/messages`（按 Anthropic 处理）就能命中，
> 所以即使客户端拼出 `/v1/messages/chat/completions`、`/v1/v1/chat/completions` 这类组合也不会再报 404。

> 提示：TraeWork 点「添加模型」时会**调用一次接口做密钥校验**，会真实消耗极少量额度——只要代理已启动且已登录就会通过。

### 4.1 TraeCode CLI（`trae_cli.yaml`）

```yaml
models:
  - name: "WorkBuddy-DeepSeek"
    open_ai:
      base_url: http://127.0.0.1:8788/v1
      api_key: "<你的本地 API Key>"
      model: deepseek-v4-pro
  - name: "WorkBuddy-GLM"
    open_ai:
      base_url: http://127.0.0.1:8788
      api_key: "<你的本地 API Key>"
      model: glm-5.3
```

### 4.2 TRAE IDE

**设置 → 模型 → 添加自定义模型**，Base URL 填 `http://127.0.0.1:8788/v1`（或 `http://127.0.0.1:8788`，两种都兼容），
API Key 与模型 ID 同上。

---

## 5. 多站点（国内版 + 国际版）

国内版与国际版**协议同构**（同一套 `/v2/plugin/auth/*` 设备授权、`/v2/chat/completions`、`/v2/billing/meter/*`），
只有域名与身份头不同，因此本项目用一张站点表统一管理：

| 站点键 | 说明 | 上游域名 |
|---|---|---|
| `cn-cli` | 国内版 CLI / IDE | `copilot.tencent.com` |
| `intl-cli` | 国际版 CLI / IDE | `www.codebuddy.ai` |
| `intl-work` | 国际版 WorkBuddy | `www.workbuddy.ai` |

> ⚠️ **额度不通用**：国内版与国际版是两套独立账号与余额（上游明确「每个账号保留自己的模型目录与余额」），
> credit 单价也不同。国际版需要单独注册、单独登录，额度不会互通。

### 5.1 分别登录

```powershell
node login.mjs                      # 默认站点 cn-cli（国内版）
node login.mjs --site intl-cli      # 国际版 CLI（codebuddy.ai）
node login.mjs --site intl-work     # 国际版 WorkBuddy（workbuddy.ai）
```

每个站点的凭证单独存在 `data/auth.<site>.json`，互不影响；国际版页面若无账号可直接注册。

> 登录页面可能存在两道步骤：**账号登录** → **CLI 授权确认**。只完成前者时上游会持续返回
> `11217: login ing...`，需要在授权页点一次「授权 / 允许」才会下发 token。

### 5.1.1 国际版实测可用模型（`intl-cli`）

国际版的「控制台模型目录」接口在网关侧受限（`403 access_denied` / 偶发 500），
因此项目为它内置了一份**实测可用清单**（`sites.intl-cli.seedModels`，可自行增删）：

| 模型 ID | 说明 |
|---|---|
| `gpt-6-astra` | GPT-6 Astra（上新中，上游 provider 偶发不可用） |
| `gpt-5.6-luna` · `gpt-5.6-terra` · `gpt-5.6-sol` | GPT-5.6 三个代号版本（`sol` 偶发不可用） |
| `gpt-5.5` · `gpt-5.4` · `gpt-5.3-codex` | 上一代 GPT 与 Codex 变体 |
| `claude-sonnet-4.6` · `claude-opus-4.6` | **Claude 系（国内版没有）**，实测为真 Claude |
| `gemini-3.1-pro` · `gemini-3.5-flash` · `gemini-3.1-flash-image` | **Gemini 系（国内版没有）** |
| `deepseek-v4.1-flash` | 实测 **0 扣费**（国内版同名模型按 x0.03 收费） |
| `glm-5.3` · `glm-5.2` · `kimi-k3` · `kimi-k2.7` · `kimi-k2.6` · `kimi-k2.5` · `minimax-m3` · `hy3` | 与国内版有交集的模型 |
| `auto` | 上游自动路由 |

**实测参考单价**（≈2.4k token 输入一次调用，来自响应里的 `usage.credit`）：

| 模型 | 扣费 credit | 每 1k 输入 token |
|---|---|---|
| `gpt-5.6-luna` | 0.06 | 0.027 |
| `gpt-5.3-codex` | 0.17 | 0.075 |
| `deepseek-v4.1-flash` | 0 | 0 |
| `gemini-3.5-flash` | 0.47 | 0.209 |
| `gpt-5.6-terra` | 0.57 | 0.252 |
| `claude-sonnet-4.6` | 2.51（同类输入） | 0.277 |
| `gpt-5.5` | 1.19 | 0.526 |

判断某个 ID 是否可用（不消耗额度）：

- `400 model [X] service info not found` → 账号无此模型
- `500 the model provider is temporarily unavailable` → 模型存在，上游临时不可用
- `200` → 可用

账号**无权限**的（实测）：`claude-sonnet-5`、`claude-opus-4.7/4.8`、`gpt-5.1-codex*`、`gemini-2.5-pro`、`gemini-3.1-flash-lite` 等。

### 5.1.2 国际版的两个坑（本项目已自动处理）

1. **首条消息必须是 `system`**：国际版硬性要求 `messages[0].role === "system"`，否则 400
   `first message is not system prompt`。本项目在出站前会自动补一条 system（内容可在
   `config.json` 的 `defaultSystemPrompt` 里改），客户端无感。
2. **目录接口不可用**：见上，用内置清单兜底；`GET /v1/models` 仍会展示这些模型。

### 5.2 请求怎么路由到站点

优先级从高到低：

1. **显式前缀**：`站点/模型`，例如 `intl-cli/claude-4.5`、`cn-cli/hy3`
2. **`config.json` 的 `modelRoutes`**：固定把某模型钉到某站点，例如 `{ "claude-4.5": "intl-cli" }`
3. **模型目录匹配**：裸 ID 时自动查各站点实时目录，**优先选择积分倍率最低的站点**
4. **`defaultSite`**：都没命中时用的兜底站点

所以日常直接写模型 ID 就行；需要跨站点区分同名模型时用前缀或 `modelRoutes`。

### 5.3 查看站点状态、积分组成与倍率

```powershell
status.cmd                       # 各站点登录态 + 剩余积分 + 积分组成与到期时间
node status.mjs --site intl-cli  # 只看某个站点
```

输出示例（含积分组成与到期提醒）：

```
■ intl-cli  国际版 CLI（codebuddy.ai）
    剩余积分：182 credits  （共 190，已用 7，4 个套餐包）
    积分组成：
      · Free Plan Subscription  [周期订阅]   100 / 100  (55%)  ×1  最近到期 2034-12-11（8 年 62 天）
      · Bonus Pack              [一次性赠送]  82 / 90   (45%)  ×3  最近到期 2026-10-16（7 天）
    ⚠ 最近将过期：Bonus Pack  剩余 82，2026-10-16 到期（还有 7 天）
    最后失效时间：2034-12-11（8 年 62 天）
```

`GET /v1/models` 会合并所有已登录站点的目录，并带出**积分倍率**（`credits` 字段，`x0.00` 表示不扣积分）：

```json
{ "id": "hy3", "site": "cn-cli", "credits": "x0.00 credits", "credits_multiplier": 0 }
```

### 5.4 稳定性与安全相关配置

`config.json` 中以下项都有默认值，不配也能跑，按需调整：

| 键 | 默认 | 说明 |
|---|---|---|
| `timeouts.metaMs` | 20000 | 模型目录 / 额度 / 登录等**元数据接口**超时（毫秒），避免上游卡住时无限等待 |
| `concurrency.perSite` | 8 | 每个站点允许的**最大并发上游请求数**，防止并发过高被上游限流 |
| `retry.max` / `retry.baseMs` / `retry.maxMs` | 2 / 600 / 5000 | 对**可重试错误**（429、5xx、连接失败）的退避重试；仅在尚未拿到响应时重试，避免重复计费 |
| `cors.allowOrigins` | `[]` | 额外放行的跨站来源白名单 |
| `access.master` | 全不限 | 主密钥的 RPM / 并发 / 每日调用 / 每日 credit 策略 |
| `access.ipAllowList` | `[]` | 来源 IP 白名单（支持单个 IP 与 IPv4 CIDR），空 = 不限制 |
| `access.audit.enabled` / `maxEntries` | true / 2000 | 是否落盘 `data/audit.log`、内存审计缓冲条数 |
| `metrics.enabled` | true | 是否开放 `GET /metrics` |
| `metrics.latencyBucketsMs` | `[50…30000]` | 延迟直方图分桶边界（毫秒） |

> **来源（Origin）策略**：服务只对**本机来源**（`127.0.0.1` / `localhost` / `[::1]`，以及配置里的 `host:port` 自身）回跨域头，
> 并直接拒绝其它陌生站点的浏览器请求（防 DNS rebinding / 网页借用本机代理白嫖额度）。
> 不带 `Origin` 的命令行 / SDK 客户端不受影响；确实需要从某个网页来源访问时，把该来源填进 `cors.allowOrigins`。

> **注意**：`apiKey` 是**主密钥**，权限最高（可管理控制台、停止服务）。
> 给外部工具用时建议在控制台「访问控制」页签发**受限密钥**，按需限定站点 / 模型 / 速率。

### 5.5 开发与测试

```powershell
npm start          # 等价于 node server.mjs
npm test           # node --test：运行 test/ 下的单元测试（零依赖，内置测试运行器）
npm run smoke      # 端到端冒烟：独立数据目录 + 空闲端口起服务，验证鉴权/限流/指标/审计等
```

- **单元测试**（67 个用例）：站点路由、SSE 帧分类、Anthropic ↔ OpenAI 转换、来源判定、credit 提取、
  自动签到开关、**访问控制（哈希 / 作用域 / 限流 / 配额 / IP 白名单）**、
  **积分组成与到期时间解析**、**data/ 目录布局与防路径穿越**。
- **冒烟测试**（87 项检查，`npm run smoke`）：用 `WB_DATA_DIR` 指向临时目录、`WB_PORT` 用空闲端口启动真实服务，
  逐项验证基础鉴权、密钥哈希落盘（明文不落盘）、站点与模型作用域（403）、RPM 限流（429）、
  Prometheus 指标内容、审计去重与状态码、积分接口形状、账号备注名、主密钥在线修改、
  用量与 CSV 导出、data 目录隔离、优雅停止。跑完自动停服并清理（加 `--keep` 保留现场）。
- 要求 **Node ≥ 20.11**（见 `package.json` 的 `engines`；`import.meta.dirname` 依赖此版本）。

---

## 6. 一键签到（仿 workbuddy-switch）

> 产品形态对标 [changexbc/workbuddy-switch](https://github.com/changexbc/workbuddy-switch) 的签到页；
> 上游接口形态参考 [88lin/workbuddy-auto-signin](https://github.com/88lin/workbuddy-auto-signin)（MIT），
> 本项目代码为独立重写，**复用本项目各站点的登录凭证**（`data/auth.<站点>.json`），不读桌面端文件。

| 方式 | 用法 |
|---|---|
| 控制台 | 「签到」页签：看各站点状态 → 点「一键签到」或「签到 + 成长中心全量」 |
| 命令行 | `node checkin.mjs`（查状态）/ `node checkin.mjs --claim`（领取）/ `node checkin.mjs --growth`（全量）/ `--site cn-cli` 只搞一个站点 |
| 双击 | `checkin.cmd`（一键领取全部已登录站点） |
| 自动签到（服务常驻） | 控制台「签到」里打开开关、设好时间；服务每天到点自动跑一轮 |
| 自动签到（Windows 计划任务） | 双击 `checkin-install.cmd` 注册每天 09:10 的任务（服务没启动也能跑，结果进 `data/checkin.log`） |

一键签到 = 先查 `POST {apiBase}/v2/billing/meter/checkin-activity-status`，未签才调
`POST {apiBase}/v2/billing/meter/daily-checkin` 领取（**幂等**：重复点只会返回「今日已签」，不会多领）。
「成长中心全量」还会顺手跑 `base={apiBase}/v2/activity/growth` 下的：领旅行礼物 → 派 Buddy →
领任务/领任务奖 → 断登补签（每轮 1 张）→ 连登兑换（7/14/28 天）→ 抽奖 → 开 Buddy 盲盒。
各段独立 try，一段失败不影响其余；401/403 会明确报「登录态失效」。

控制台接口（鉴权同其它控制台接口）：

| 路径 | 方法 | 说明 |
|---|---|---|
| `/console/api/checkin/status` | GET | 各站点签到状态（今日是否已签 / 连签天数 / 累计积分） |
| `/console/api/checkin/claim` | POST | 一键领取（body 可选 `{ sites: [...] }`，默认全部已启用站点） |
| `/console/api/checkin/growth` | POST | 签到 + 成长中心全量（`{ includeCheckin: true }`） |
| `/console/api/checkin/auto` | GET/POST | 自动签到开关（`{ enabled, hour, minute, sites }`） |

一键签到默认覆盖**全部已登录槽位**（见 6.1），包括克隆出来的账号池中的每个账号；
想只签某个号，可指定 `sites` 列表（槽位键），例如 `POST /console/api/checkin/claim { "sites": ["cn-2"] }`。

---

## 7. 常见问题

| 现象 | 处理 |
|---|---|
| `未知路径 POST /v1/messages/chat/completions (404)` | 客户端把路径拼重复了。服务端现已容错（按 `/chat/completions` / `/messages` 后缀识别），若仍报错请把地址改为基础地址 `http://127.0.0.1:8788/v1`（或完整 URL `…/v1/chat/completions`） |
| 401「尚未登录」 | 该站点未登录：`node login.mjs --site <站点名>`（国内版可省 `--site`） |
| 401「登录态失效」 | 该站点 refreshToken 已过期，重新登录该站点 |
| 401「该 API Key 已被停用」 | 该密钥在控制台「访问控制」里被停用了，重新启用或换密钥 |
| 402 额度不足 | 该站点剩余积分用完（两边额度不通用，可切到另一站点）；到控制台「积分」页看各包剩余与到期时间 |
| 403「该密钥无权访问模型 / 站点」 | 受限密钥的作用域不含该模型 / 站点；在控制台「访问控制」里调整该密钥的白名单 |
| 403「来源 IP 不在允许列表内」 | 在控制台「访问控制」里补充 `access.ipAllowList`（或清空表示不限制） |
| 429 限流 | 稍后重试，降低并发；若是「超出该密钥的每分钟请求上限 / 每日配额」，到「访问控制」调高或换密钥 |
| 429「超出该密钥的并发上限」 | 该密钥同时在途请求过多，降低客户端并发 |
| `model xxx is only available for authorized users` | 该模型你的账号无权限，换第 8 节清单里的模型 |
| 国际版报 401/500 但国内版正常 | 国际版是独立账号体系，需要单独 `--site intl-cli` / `--site intl-work` 登录 |
| 模型回答被截断 | 上游「思考」也计入输出 token；在 TraeWork 高级配置里调大输出上下文窗口 |
| TraeWork 里模型列表为空 | TraeWork 不拉 `/v1/models`，模型 ID 手填即可 |
| 忘记某个受限密钥的明文 | 设计上无法找回（只存哈希），删除后重新生成一个 |
| 想换端口 / 换 Key | 改 `data/config.json` 后重启服务（也可用 `WB_PORT` / `WB_API_KEY` 环境变量） |
| 想关掉鉴权 | 把 `data/config.json` 的 `apiKey` 设为 `""`（仅本机使用时才可以） |
| 想换数据目录位置 | 设环境变量 `WB_DATA_DIR=D:\wb-data` 后重启 |
| 旧版本的根目录配置文件不见了 | 首次启动已自动迁入 `data/`（只移动、不删除）；也可设 `WB_DATA_DIR` 指回原位置 |

---

## 8. 示例模型清单

> 各账号可用模型不同（取决于套餐/权限），**实际清单以 `GET /v1/models` 实时返回为准**。下表仅为一个普通账号的示例：

| 模型 ID | 名称 | 上下文 / 最大输出 |
|---|---|---|
| `deepseek-v4-pro` | DeepSeek-V4-Pro | 1M / 50k |
| `deepseek-v4.1-flash` | DeepSeek-V4.1-Flash | 1M / 128k |
| `glm-5.3` / `glm-5.3-flash` | GLM-5.3 / Flash | 1M / 48k |
| `glm-5.2` / `glm-5.1` | GLM-5.2 / 5.1 | 1M / 48k |
| `kimi-k2.7` | Kimi-K2.7-Code | 256k / 32k |
| `kimi-k3-1` | Kimi-K3 | 1M / 32k |
| `minimax-m3` | MiniMax-M3 | 512k / 128k |
| `hy4-preview` / `hy3` / `hy3-x` | Hy4 preview / Hy3 | 1M / 64k |
| `glm-5v-turbo` | GLM-5v-Turbo（视觉） | 200k / 64k |
| `auto` | 上游自动路由 | 168k / 32k |

> 未订阅相应权限时，Claude 系列（`claude-sonnet-4.6` 等）会返回 400 `only available for authorized users` ——
> 想用 Claude / GPT / Gemini，请走**国际版站点**（见 5.1.1）。

想用别名调用固定模型，可在 `config.json` 的 `modelAliases` 里加映射：

```json
"modelAliases": { "gpt-4.1": "deepseek-v4-pro", "claude": "intl-cli/claude-sonnet-4.6" }
```

---

## 9. 接口一览

| 路径 | 方法 | 说明 |
|---|---|---|
| `/v1/models` | GET | 合并所有已登录站点的模型清单，含 `site` 与 `credits` 倍率（5 分钟缓存，失败回落配置） |
| `/v1/chat/completions` | POST | OpenAI 兼容补全（流式/非流式、工具调用、developer 角色归一） |
| `/v1/messages` | POST | Anthropic Messages（流式事件完整：message_start → content_block_* → message_delta → message_stop） |
| `/v1/messages/count_tokens` | POST | token 估算 |
| `/status` | GET | 各站点登录状态 + 剩余积分 + **积分组成与到期时间**（`?site=intl-cli` 可只看一个站点） |
| `/metrics` | GET | **Prometheus 指标**（文本格式 0.0.4），需鉴权；`metrics.enabled=false` 时返回 404 |
| `/health` | GET | 健康检查（无需鉴权），含各站点登录态 |
| `/` | GET | 服务信息（版本、数据目录、端点列表） |
| `/admin/shutdown` | POST | 优雅停止服务（**仅主密钥**可用） |

带不带 `/v1` 前缀都能访问。鉴权：`Authorization: Bearer <apiKey>` 或 `x-api-key: <apiKey>`；
也可以使用控制台「访问控制」页签发的**受限密钥**（受站点 / 模型 / 速率限制）。

控制台后端接口（`/console/api/*`，需会话令牌或主密钥）：

| 路径 | 方法 | 说明 |
|---|---|---|
| `/state` | GET | 站点总览（登录态、账号昵称 / UID / 企业 ID / 备注名、积分、积分组成与最近到期、模型数、数据目录） |
| `/credit` | GET | **积分组成与到期时间**（`?site=` 过滤、`?inactive=1` 含已失效包；响应形状固定，未登录站点返回空数组） |
| `/monitor` | GET | 监控总览（延迟分位、小时分布、按站点 / 密钥、运行时在途） |
| `/usage` / `/usage/reset` / `/usage/export` | GET/POST/GET | 用量快照 / 清空 / **导出 CSV** |
| `/keys` / `/keys/update` / `/keys/remove` | GET/POST | 访问密钥的列表（掩码）/ 新建（返回一次明文）/ 修改 / 删除 |
| `/api-key` / `/api-key/generate` | POST/GET | **在线修改主密钥**（≥4 位或留空关闭鉴权）/ 生成随机密钥建议 |
| `/site/account-label` | POST | 设置账号**备注名**（便于区分同组多账号；传空字符串恢复默认） |
| `/access` | GET/POST | 访问策略（IP 白名单、审计开关、指标开关、主密钥策略） |
| `/audit` / `/audit/clear` | GET/POST | 访问审计查询（可按失败 / 拒绝过滤，`?from=file` 读磁盘历史）/ 清空内存缓冲 |
| `/models` / `/default-model` / `/aliases` / `/probe` | GET/POST | 模型清单 / 切换默认 / 别名 / 批量探测 |
| `/checkin/*` | GET/POST | 签到状态 / 领取 / 成长中心 / 自动签到开关 |
| `/login/*` / `/logout` | POST/GET | 设备授权登录 / 退出登录 |
| `/sites` / `/sites/remove` / `/sites/default` | POST | 账号池槽位的新增 / 删除 / 设为默认 |
| `/logs` | GET | 内存日志（增量拉取） |
| `/service/stop` | POST | 停止服务 |

---

## 10. 已验证项（Windows + Node 22 实测）

- ✅ 设备授权登录、`refresh_token` 自动续期（accessToken 临期 5 分钟内自动刷新，遇 401 强刷重试一次）
- ✅ 国内版 / 国际版多站点：站点表、独立凭证、`站点/模型` 前缀路由、目录匹配自动选站点
- ✅ 国际版：`claude-sonnet-4.6` / `claude-opus-4.6` / `gpt-5.4` / `gemini-3.1-pro` 裸模型名自动路由并实测可用
- ✅ 国际版自动补 system 首条消息（上游硬性要求），工具调用实测返回正确 `tool_calls`
- ✅ OpenAI 非流式 / 流式；Anthropic 流式事件序列
- ✅ 工具调用：流式聚合 `tool_calls`、`tool_choice` 对象→字符串归一、`developer` 角色→`system`
- ✅ 多轮工具回灌（agent 形态：assistant.tool_calls → tool 结果 → 最终回答）
- ✅ 剩余积分查询、动态模型清单、积分倍率展示
- ✅ **积分组成与到期时间**：cn-cli 实测 24 个套餐包、intl-cli 4 个包，逐包解析剩余量与失效时刻，
  正确区分「周期订阅 / 一次性赠送」并给出最近到期提醒
- ✅ **data/ 目录迁移**：旧版根目录的 config / auth / usage / checkin / 日志自动迁入 `data/`，不覆盖已有数据
- ✅ **访问控制**：密钥 SHA-256 哈希落盘（无明文）、站点与模型作用域（403）、RPM 与并发限流（429）、
  每日配额、IP 白名单、审计去重且状态码准确
- ✅ **监控**：`/metrics` 输出 Prometheus 文本（存活 / 调用 / token / credit / 直方图 / 分位 / 按密钥），
  延迟分位与 24 小时分布、按站点与密钥聚合、CSV 导出
- ✅ **苹果风格控制台**：明暗双主题（跟随系统 / 手动）、毛玻璃材质、iOS 分段控件与开关，
  十个页签在真实浏览器中验证渲染与交互（含建密钥、限流提示、审计表）
- ✅ **账号一眼可辨**：站点卡片显示账号昵称 / 完整 UID / 企业 ID / 登录时间，支持自定义备注名，
  同一站点挂多个账号时不会认错
- ✅ **主密钥可在网页里改**：修改后新密钥立即可用、旧密钥立即 401、正确落盘 `data/config.json`，
  短密钥给出弱口令提醒
- ✅ **端到端冒烟**：`npm run smoke` 87 项检查全绿（独立数据目录 + 空闲端口，跑完自动清理）

---

## 11. 安全与合规

- 仅监听 `127.0.0.1`；凭证在 `data/auth.<站点>.json`（权限 0600）、密钥哈希在 `data/keys.json`，
  **不要外传**、不要提交仓库（`.gitignore` 已忽略整个 `data/`）。
- 给外部工具用时建议签发**受限密钥**（限定站点 / 模型 / 速率），不要直接分发主密钥。
- 走的是 **CodeBuddy 官方 CLI 所用的非公开接口**，无官方文档、可能随时变更；本项目只做本机自用转发。
- 请仅用于**本人账号**，遵守腾讯 CodeBuddy / WorkBuddy 用户协议；额度规则与风控由上游决定。
- 本项目与腾讯无任何关联，未获官方授权或认可，请自行评估使用风险。

---

## 12. 致谢

上游协议细节参考了以下开源项目的公开实现（本项目代码为独立重写，仅借鉴接口形态与字段约定）：

- [Sliverkiss/workbuddy2api](https://github.com/Sliverkiss/workbuddy2api)（Go，MIT）— OAuth 设备授权流程、
  上游端点与请求头约定、SSE 帧规范化思路
- [rocky99261/workbuddy-proxy](https://github.com/rocky99261/workbuddy-proxy)（Python）— 账号头（uid / enterpriseId / domain）
  与 IDE 侧调用形态
- [maiphucgiang/codebuddy2api](https://github.com/maiphucgiang/codebuddy2api)（Python）— 国内版 / 国际版站点域名划分、
  积分倍率与额度互不通用等口径说明
- [88lin/workbuddy-auto-signin](https://github.com/88lin/workbuddy-auto-signin)（Python，MIT）— 每日签到
  `checkin-activity-status` / `daily-checkin` 与成长中心 `v2/activity/growth` 各接口形态
- [changexbc/workbuddy-switch](https://github.com/changexbc/workbuddy-switch)（MIT）— 「一键签到 / 自动签到」
  产品形态（本项目控制台「一键签到」页签即仿此）

Trae / TraeWork / CodeBuddy / WorkBuddy 均为其各自所有者的商标，本项目与上述公司无隶属关系。

---

## 13. 许可证

[MIT](LICENSE)

