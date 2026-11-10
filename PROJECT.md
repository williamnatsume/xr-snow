# XR SNOW — 项目交接文档

> 给接手的 Claude Code（包括 Mac 上的新会话）：**先完整读这份文件，再读 `docs/ski-nav.md`**。
> 这个仓库是公开的（GitHub Pages），不要写入个人信息、账号、令牌或私人联系方式。
> 最后更新：2026-11-04（Mac 上的 Claude Code 会话：环境装好，开始 M1）

## 0. 一句话

做一款滑雪镜 AR HUD：眼前显示速度，并在雪道岔口之前用语音提示该走哪条分支。现在是原型验证阶段，用户一个人开发，中文母语，在日本。

## 1. 现状

| 部分 | 状态 | 入口 |
|---|---|---|
| 速度 HUD（网页） | ✅ 可用。640×400、黑底透明；模拟 / GPX 回放 / GPS；轨迹记录导出 GPX | `speed-hud.html`，线上 https://williamnatsume.github.io/xr-snow/ |
| 雪场语音导航 MVP（网页） | ✅ 模拟器可完整跑通；真实 GPS 在 iPhone 前台可用（未上雪实测） | `ski-nav.html`，线上 https://williamnatsume.github.io/xr-snow/ski-nav.html |
| 雪场数据 | 虚构演示雪场 + 神乐（かぐら，OSM 导入，**未核实**） | `resorts/*.json`，导入脚本 `tools/import-osm.mjs` |
| 自动测试 | ✅ 30 项全部通过（含 3 项 iOS 打包文件测试） | `npm test` |
| 原生 iOS App | ✅ M1 完成：iPhone 18 Pro Max 模拟器（iOS 27.2）上自检通过，12 条播报与 npm test 一致；界面手动跑通一次模拟导航。🟡 M2 进行中：已装到用户的 iPhone 18 Pro Max（iOS 27.0.1），真机自检通过；用户确认模拟导航时能听到中文语音播报（2026-11-04）；真实 GPS 待户外试用 | `ios/XRSnowNav` |
| 硬件 | 0.23" Micro-OLED 光波导（Sony ECX336CN，640×400）经 HDMI 接电脑可显示；接 iPhone 蓝屏 | 见第 6 节 |

运行网页版：

```bash
npm start      # http://localhost:8080/ski-nav.html （需要 Node，零依赖）
npm test
```

## 2. 代码结构（导航）

分层设计，原生 App 要复用其中的“核心逻辑”：

| 层 | 文件 | 平台依赖 |
|---|---|---|
| 地图载入 / 校验 / 投影 | `nav/resort.js`、`nav/geo.js` | 无（纯 JS） |
| 路线规划（Dijkstra） | `nav/planner.js` | 无 |
| 指令生成（左右判断） | `nav/instructions.js` | 无 |
| 定位匹配 | `nav/matcher.js` | 无 |
| 导航状态机 | `nav/navigator.js` | 无 |
| 自然语言 → 条件 | `nav/nlp.js` | 无 |
| 模拟器 | `nav/simulator.js` | 无 |
| **定位适配** | `nav/position.js` | 浏览器 Geolocation → 原生要换成 CoreLocation |
| **语音适配** | `nav/voice.js` | 浏览器 speechSynthesis → 原生要换成 AVSpeechSynthesizer |
| 界面 / 地图 | `ski-nav.html`、`nav/app.js`、`nav/mapview.js` | 浏览器 DOM / SVG |

核心接口（原生层只需要对接这些）：

```js
const resort = loadResort(json);                       // nav/resort.js
const plan = planRoute(resort, { startNode, goalNode }, prefs);   // nav/planner.js
const nav = new Navigator(resort, { lang: 'zh' | 'ja', onSpeak: ({ text, reason, key, voice }) => {} });
nav.start({ route: plan, destNode, prefs }, nowMs);
nav.onFix({ t, x, y, acc, speed });   // x/y：resort.proj.toXY(lat, lon) 得到的米制坐标；speed m/s 或 null
nav.tick(nowMs);                      // 每秒调用一次，用于发现定位中断
nav.snapshot(nowMs);                  // 界面用：state、nextText、distToNext、unreliable……
```

必须保持的行为（都有测试）：不进入关闭 / 超难度雪道；无路线时不偷偷放宽；左右按进入方向计算；定位中断、精度不足、相邻雪道无法区分时不给确定指令；偏航只说“可能偏离路线，请在安全位置停下查看地图”，从当前雪道向前重新规划，不指挥掉头或急转。

## 3. 实测结论（已有）

- 2026-10-16 iPhone 13 Pro 开车 21 分钟、约 9.9 km：设备速度与位置推算速度中位差 0 km/h；定位误差中位数 10 m（87% ≤ 20 m）；启动后前 1–2 分钟误差 30–50 m；隧道等处有最长 18 秒中断。结论：室外 GPS 测速可靠。
- 室内测试无参考价值（Wi-Fi 定位、无设备速度）。
- 还没有任何滑雪实测数据。播报时机、偏航判断等阈值都是**待实测的初始值**（`NAV_CFG` / `MATCH_CFG` / `INSTR_CFG`）。

## 4. 下一步：原生 iOS App

### 目标
解决网页版最大的问题：**iPhone 锁屏 / 放进口袋后，网页会停止定位和播报**。

### 设备
- 开发机：Apple 芯片的 MacBook Pro（2021，借用；用户会用独立的 macOS 用户账号）
- 测试机：iPhone 18 Pro Max（最新 iOS）
- Apple ID：先用免费个人团队（真机安装 7 天过期），需要 TestFlight 时再升级付费开发者账号

### 架构（推荐）
- **复用 JS 核心逻辑**：用 esbuild 把 `nav/` 的纯逻辑模块打包成一个 IIFE（例如 `ios/XRSnowNav/Resources/navcore.js`，全局名 `XRNav`），在 App 里用 **JavaScriptCore（JSContext）** 运行。网页和 App 共用同一份导航逻辑，`npm test` 仍然覆盖它。
  - 新建一个入口 `nav/core-entry.js`，只导出 loadResort / planRoute / Navigator / buildManeuvers / maneuverText / parseRequest，不引用 DOM。
  - 打包命令放进 `package.json`（如 `npm run build:ios`）。
- **定位**：CoreLocation。`allowsBackgroundLocationUpdates = true`，`pausesLocationUpdatesAutomatically = false`，`activityType = .otherNavigation`，`desiredAccuracy = kCLLocationAccuracyBest`；iOS 17+ 可配合 `CLBackgroundActivitySession`。把 `CLLocation` 转成 `{ t, x, y, acc, speed }` 喂给 `nav.onFix`（速度 < 0 或误差 > 50 m 时传 null，与网页版一致）。
- **语音**：`AVSpeechSynthesizer`；`AVAudioSession` 类别 `.playback`、模式 `.voicePrompt`、选项 `.duckOthers` + `.interruptSpokenAudioAndMixWithOthers`，播报时压低音乐音量，蓝牙耳机可听。中文 `zh-CN`、日语 `ja-JP`（神乐建议日语，中文语音读不出假名）。
- **Info.plist / Capabilities**：`NSLocationWhenInUseUsageDescription`、`NSLocationAlwaysAndWhenInUseUsageDescription`；Background Modes 勾选 **Location updates** 和 **Audio**。
- **界面**：SwiftUI，先做最简：雪场 / 起点 / 目的地 / 难度上限 / 避开平路 / 优先短路线 → 规划 → 开始 / 暂停 / 结束；大字显示下一条指令、距离、定位状态；重播、静音。之后再做锁屏实时活动（Live Activity）。
- **数据**：`resorts/*.json` 打包进 App，离线可用。
- **定时器**：后台时用定位回调驱动，并在每次回调里调用 `nav.tick`；前台另加 1 秒定时器。
- **隐私**：位置只在内存中使用；可选的轨迹记录保存在本机，导出 GPX 需用户操作。

### 里程碑与验收
1. **M1 能跑**：Xcode 工程 `ios/XRSnowNav`，JSContext 载入 navcore.js 和虚构雪场，App 内置模拟器（复用 `Simulator`）跑完一条路线，日志里的播报序列与 `npm test` 的同一场景一致。
2. **M2 真机**：装到 iPhone，真实 GPS + 语音在前台工作；神乐数据可选（需确认“数据未核实”）。
3. **M3 锁屏**：锁屏、放进口袋、播放音乐的情况下，走路 / 开车实测能持续定位并按时播报；定位中断时正确进入“定位不可靠”。
4. **M4 上雪**：神乐实测，同时记录 GPX（包含定位误差），回来分析并调整阈值。

### 已实现（2026-11-04，Mac）

- `nav/core-entry.js`：原生入口。`createSession(雪场 JSON 文本)` 返回会话对象，参数是普通值、返回值都是 JSON 字符串；播报进队列，原生层每次调用后 `drainSpeech()` 取走。另有 `scenarioTexts()`。
- `nav/scenario.js`：无界面完整模拟（原来在 `tests/helpers.mjs` 里），测试和 App 自检共用。
- `npm run build:ios`（`tools/build-ios.mjs`，用 esbuild）：生成 `ios/XRSnowNav/Resources/navcore.js`（IIFE，全局 `XRNav`），复制 `resorts/*.json`，并用源码跑 M1 场景生成 `selfcheck-expected.json`。**改了 `nav/` 或 `resorts/` 后要重跑并一起提交**；`tests/core-bundle.test.mjs` 会发现打包文件过期。
- M1 场景（`tools/selfcheck.mjs`）：虚构雪场，山顶 → 山脚餐厅，中级以下，模拟器种子 3，共 12 条播报。
- `ios/XRSnowNav`：Xcode 工程（文件夹同步组，`Sources/`、`Resources/` 里新增文件会自动加入，不用改工程文件），iOS 17+，SwiftUI。
  - `NavCore.swift`：JSContext 载入 navcore.js；`runSelfCheck()` 按与测试相同的顺序逐秒模拟并对比期望序列。启动参数 `-selfcheck` 会在启动时自动自检并在日志输出 `[自检]`。
  - `LocationService.swift`：CoreLocation，后台定位 + `CLBackgroundActivitySession`。
  - `SpeechService.swift`：AVSpeechSynthesizer，`.playback` / `.voicePrompt` / duck。
  - `NavModel.swift`、`ContentView.swift`：设置 → 规划 → 导航（模拟器 1×/5×/20×、走错分支、定位中断；真实 GPS 需勾选“数据未核实”）。
  - Bundle ID `io.github.williamnatsume.XRSnowNav`。工程文件里签名团队**故意留空**（公开仓库不放个人团队 ID）：命令行编译时传 `DEVELOPMENT_TEAM=<团队 ID>`，团队 ID 用 `defaults read com.apple.dt.Xcode IDEProvisioningTeamByIdentifier` 查。Xcode 界面里选了团队后，不要提交 project.pbxproj 里的这项改动。

命令行编译检查（不需要签名）：

```bash
cd ios/XRSnowNav && xcodebuild -project XRSnowNav.xcodeproj -target XRSnowNav -sdk iphoneos CODE_SIGNING_ALLOWED=NO build
```

模拟器上跑 M1 自检（命令行，看日志里的 `[自检]`）：

```bash
D="iPhone 18 Pro Max"; xcrun simctl boot "$D"
cd ios/XRSnowNav && xcodebuild -project XRSnowNav.xcodeproj -scheme XRSnowNav -destination "platform=iOS Simulator,name=$D" -derivedDataPath build build
xcrun simctl install "$D" build/Build/Products/Debug-iphonesimulator/XRSnowNav.app
xcrun simctl launch "$D" io.github.williamnatsume.XRSnowNav -selfcheck
xcrun simctl spawn "$D" log show --last 1m --predicate 'process == "XRSnowNav" AND eventMessage CONTAINS "自检"'
```

装到 iPhone（已配对、已开开发者模式；免费个人团队装的 App 7 天后过期，重装即可）：

```bash
UDID=$(xcrun devicectl list devices | awk '/physical/ {for(i=1;i<=NF;i++) if($i ~ /^[0-9A-F]{8}-[0-9A-F]{16}$/) print $i}' | head -1)
cd ios/XRSnowNav && xcodebuild -project XRSnowNav.xcodeproj -scheme XRSnowNav -destination "id=$UDID" -derivedDataPath build-device -allowProvisioningUpdates DEVELOPMENT_TEAM=<团队 ID> build
xcrun devicectl device install app --device $UDID build-device/Build/Products/Debug-iphoneos/XRSnowNav.app
xcrun devicectl device process launch --device $UDID --terminate-existing --console io.github.williamnatsume.XRSnowNav -- -selfcheck
```

第一次安装后用户要在 iPhone 上：设置 → 通用 → VPN 与设备管理 → 信任开发者。

小问题（未修）：到达后速度仍显示最后一次定位的速度。

### 已知风险
- 免费个人团队下某些能力（如推送）不可用；Background Modes（定位、音频）应可用，如不行再升级付费账号。
- 后台长时间定位耗电大，低温下更明显：需要实测。
- 神乐 OSM 数据未核实：开放状态全部未知，15 处连接为程序推算，みつまたロープウェイ未连通。

### 方向调整（2026-11-04，用户提出）：“雪人” AI 滑雪伙伴

- App 显示名改为 **雪人**（好喊；Bundle ID 不变）。
- 目标：不用手指点，用说话告诉它去哪，它规划路线并语音确认，导航中可以随时问（还有多远、再说一遍、换条简单的路）。导航功能必须保证，AI 只负责理解意图，路线和转弯仍由规划器按地图决定。
- 还需要“锁屏测试 / 轨迹记录”模式（M3 用，M4 上雪记录 GPX）。
- **用户 iPhone（国行 iPhone 18 Pro Max，iOS 27.0.1，地区 JP）真机能力检查结果**（App 启动时写日志 `[能力]`）：
  - 本机大模型（Foundation Models）：**不可用，deviceNotEligible**（国行机型限制；苹果据报道 12 月在国内上线 Apple Intelligence，但是否开放给第三方 App 未知）
  - 旧版语音识别 SFSpeechRecognizer：zh-CN 仅联网，ja-JP 可离线
  - 新版 SpeechTranscriber（iOS 26+）：zh-CN、ja-JP 模型**都已安装，可离线转写** → 语音输入用这个

#### 已实现（2026-11-04）
- **对话层（JS，可测试）** `nav/companion.js`：统一意图结构 `INTENT_SCHEMA`（navigate / confirm / cancel / stop / pause / resume / distance / repeat / easier / where / chat / unknown）；本地规则 `rulesIntent`；地名解析 `resolvePlace`（歧义追问、不在图上就说找不到）；对话流程：说目的地 → 复述路线（起终点、难度、距离、时间、经过的雪道）并问“要出发吗” → 确认后开始导航；导航中可问距离、重复、换更简单的路线（从当前雪道向前重规划，没有就如实说明）、我在哪、暂停 / 继续 / 结束。条件只在规划成功后才记住。`brainSystemPrompt` 给云端用。`tests/companion.test.mjs` 12 项。
- **iOS**：
  - `SpeechInput.swift`：SpeechAnalyzer + SpeechTranscriber 离线识别（iOS 26+，所以部署目标改为 iOS 26），停顿 1.2 s 算一句。用 iPhone 自带麦克风（不用 AirPods 通话麦克风）。**模拟器上禁用**（访问麦克风会让模拟器音频系统超时崩溃，实测）。
  - 唤醒：设置里“随时喊‘雪人’”（默认开，持续听，只理会带“雪人”的话）；大按钮 / Siri / 操作按钮（App Intent “和雪人说话”）打开 8 秒免唤醒窗口；雪人问“要出发吗？”后自动打开窗口等回答。播报时输入静音。
  - `CloudBrain.swift`：Claude Messages API（原始 HTTP），`output_config.format` json_schema 结构化输出 + effort low，默认 `claude-opus-5-5`（`fallbacks: "default"`），可选 `claude-haiku-5-5`；10 s 超时；失败 / 没密钥 / 被拒绝 → 本地规则。密钥存钥匙串，用户在设置里粘贴。**云端路径未实测（开发机没有 API 密钥）。**
  - `TrackRecorder.swift`：轨迹记录 + GPX 导出（格式同网页版 speed-hud，含 xrsnow:acc 误差）；“锁屏测试”模式：只定位记录，每 5 分钟语音报告点数 / 最长中断 / 电量，中断 >10 s 提醒、恢复时报中断秒数。真实 GPS 导航时默认也记录。
  - 界面改为对话为主（`ContentView.swift`）：状态栏、导航卡片、对话气泡、大麦克风按钮、键盘输入；设置页放雪场、定位来源、说话、云端密钥、轨迹 / 锁屏测试、开发。
  - 测试用启动参数：`-say "一句话"`（可多个，按顺序当作用户说的话）、`-selfcheck`。
- **未验证**：真机上的语音识别准确度和唤醒；“一直在听”时播报会不会压低音乐（用了 `usesApplicationAudioSession = false`）；云端理解；锁屏测试本身（等用户户外测）。

#### 雪人 v2：陪滑 / 教练人设（2026-11-04）
- 有 API 密钥时，**Claude 直接说话**：系统提示 `companionSystemPrompt`（陪滑伙伴 + 教练，回复会被朗读：口语、短、≤40 字；事实只来自工具），工具 `COMPANION_TOOLS`（plan_route / start_navigation / cancel_route / easier_route / control_navigation / get_status / repeat_instruction），由 `session.tool()` 在 JS 里执行（复用对话管理器，路线仍由规划器决定）。Swift 侧 `CloudBrain.converse` 做工具循环（最多 5 轮，助手内容原样带回）。
- 默认模型改为 **claude-haiku-5-5**（延迟最低，每句约 0.05 日元）；可选 Sonnet 5.5 / Opus 5.5（UserDefaults 键 `cloudModel2`）。没有密钥 / 失败 → 离线规则（原来的模板回复）。
- 到达目的地时总结这一趟（距离、用时、最高速度、今天第几趟），云端用人设说，离线用模板。云端开始导航时不再重复播“开始导航，前往…”。
- 唤醒：识别片段里一出现“雪人”就轻震 + 短提示音（系统音 1113）；0.7 秒内没接着说才说“我在”。同音字（学人、血人等）也算。
- 声音：自动选已安装的最高音质中文 / 日语声音（高级 / 增强声音要用户在系统设置里下载）。
- 真机日志：背景里的音乐、电视会被识别成文字，但没有“雪人”就忽略（实测正常）。
- 未实测：云端对话（开发机没有密钥）、新唤醒反馈。

#### 语音输入 v3（2026-11-04）
- 同时听两种语言：“我说的语言”（默认中文）+“第二语言”（默认日语，可换英语），每句话取置信度最高的结果；雪人用用户那句话的语言回答（回复声音按文字自动选中/日/英）。**iOS 限制同时最多 2 个 SpeechTranscriber**（第 3 个报 “Maximum number of recognizers reached”，放进同一个 SpeechAnalyzer 也一样，真机实测），所以中日英三种不能同时听。
- 导航播报语言（神乐默认日语）和说话语言分开：之前选神乐时把识别也切成了日语，导致听不懂中文（真机日志 `开始听：ja-JP`）。
- 唤醒词加了 “snowman / スノーマン / 雪だるま”。
- 修“说了‘我在’之后就没反应”：播报时的静音改为按回复长度估算的最长时限（不再依赖播报结束回调）；监听音频打断和引擎配置变化自动重启麦克风；2 秒没收到音频也重启。
- 旁边的人声（电视等）不再堆进缓冲；喊雪人后最多听 7 秒。

#### 语音管线 v4 + 陪滑口吻播报（2026-11-04）
- **回声消除**：`SpeechInput` 开启 `inputNode.setVoiceProcessingEnabled(true)`（AEC + 降噪 + AGC），其他 App 音乐只轻微压低（duckingLevel .min）；雪人的声音用 `AVSpeechSynthesizer.write` 合成后从同一个 AVAudioEngine 的 AVAudioPlayerNode 播出，所以能被消除。**真机自检通过**：启动参数 `-say "雪人，去山脚餐厅，不走高级道"`，雪人播了 11 秒路线说明，识别结果里没有出现她自己的话。说话时用户喊“雪人”会打断她。回声消除不可用时退回“说话时不收音”。播报有超时保险（预计时长 + 3 秒）。
- **按音频时间切句**：识别片段带 `audioTimeRange`，一句话交出去后记下结束时间，之后重发的更早的词丢掉 → 不再重复（之前日志里“雪人。我们去山脚下”→“雪人。我们去山脚下。山脚餐厅”）。
- 等回答时（没喊雪人）听到 ≤3 字又听不懂的词不理会。
- **播报改成陪滑口吻**（`nav/instructions.js` 的 `maneuverText` / `SYSTEM_TEXT`，中日文）：例如“前面150米有个岔口，到时候靠左，二号雪道”“岔口到了，靠左，二号雪道”“好嘞，进二号雪道了”“到啦，山脚餐厅！”“诶，好像走偏了。先找个安全的地方停一下，看看地图”。确认 / 到达等用 `pick()` 按指令 id 固定轮换几种说法。安全原则不变（不指挥掉头、定位不可靠时不报转弯）。测试已同步更新，44 项通过。
- **与滑呗 / Slopes 的关系（调研结论）**：两者都没有公开 API（滑呗未找到开放平台；Slopes 只有 Apple 健康 / Garmin / GPX 导入等间接途径）。它们的雪道图是自有 / 授权数据，不能拿来用。可行方向：雪人和它们同时开（它们记录、雪人导航）；地图数据用 OpenSkiMap / OpenStreetMap（可下载 GeoJSON，覆盖日本雪场），以后读 Apple 健康里的滑雪记录做总结。

#### 云端对话提速 + 声音（2026-11-05）
- 用户已在手机上填好 API 密钥（只存在手机钥匙串），云端对话真机可用。
- **流式**：`CloudBrain.converse` 用 SSE（`stream: true`）边收边按句子切（`SentenceChunker`：句末标点切，长句在逗号切）交给 `onSentence` 朗读；工具调用的助手内容（含 thinking 签名、tool_use 的 input_json）在流里拼回原样带回。
- **先应一声**：要调用工具且还没说过话时，先说“嗯，我看看 / 好，我查一下”（`fillerLine`）。
- 真机实测：查路线类 1.4 秒出声（原来 3.9 秒才开口），闲聊第一句 1.3 秒。
- **声音**：用户手机上中日文声音全是“普通”音质（quality 1），所以机械。设置里加了“雪人的声音”选择 + 试听；自动选音质最高的。要像真人得让用户在 系统设置 → 辅助功能 → 朗读内容 → 声音 下载“高级 / 增强”声音。语速 ×1.06、音调 ×1.05。
- 更像真人的下一步（未做）：云端语音合成（需要另一个服务和费用，且有网络延迟）。

#### 实时语音：OpenAI Realtime（2026-11-08）
- 选型：调研（Artificial Analysis / Getstream / Inworld）结论是 OpenAI Realtime 延迟最低、推理最强；Gemini Live（Project Astra 的底层）多语言覆盖更广。当前模型 `gpt-realtime-2.1` / `gpt-realtime-2.1-mini`（旧的 `gpt-realtime` / `gpt-realtime-mini` 已弃用，2027-01-20 停用；beta 头 `OpenAI-Beta: realtime=v1` 已移除）。
- `RealtimeSession.swift`：WebSocket `wss://api.openai.com/v1/realtime?model=…`，`Authorization: Bearer`；`session.update`（type realtime、audio.input/output PCM 24kHz、server_vad 450 ms、近场降噪、输入转写 gpt-4o-mini-transcribe、tools = COMPANION_TOOLS 转成扁平 function 格式、reasoning low）；处理 output_audio.delta / done、transcript、speech_started（插话：停播 + conversation.item.truncate）、function_call_arguments.done（JS 执行工具 → function_call_output → response.done 后 response.create）、error（鉴权 / 额度错误时关闭并退回 Claude）。
- 控制成本和隐私：唤醒词仍在本机识别；听到“雪人”就预先连接，本机把这句话听完后作为文字发过去（rtWaitingLocal），之后麦克风声音才直送云端（本机识别器暂停）；20 秒没人说话自动挂断。只喊“雪人”时让模型打个招呼。
- 音频：麦克风 → `RealtimeTap` 在音频线程转 24kHz PCM16；回复声音 → 同一个 AVAudioPlayerNode 播（回声消除有效）。转弯播报仍由本机 TTS 负责。
- 设置：实时语音开关、OpenAI 密钥（钥匙串，单独账户名）、模型、声音（marin / cedar 推荐）。启动参数 `-rtsay "一句话"` 测试实时路径。
- 修：`threshold: 0.55` 被 JSONSerialization 写成 0.55000000000000004，服务端报 decimal_max_decimal_places_exceeded → 改 0.5（二进制能精确表示的值）。
- 保温：20 秒没人说话只停止送声音（不再产生音频 token），连接再保持 5 分钟，下次唤醒免连接；5 分钟后关闭。`rtStreaming` 才把非唤醒的话交给云端。
- **真机实测（用户手机，-rtsay）**：连接就绪 1.0–2.0 秒，就绪后约 1 秒开口；会主动调用 plan_route（用户当时选的是神乐，没有“山腰站”，如实说找不到）；20 秒后转保温。用户亲口对话、插话尚未实测。

#### 对话复盘修正（2026-11-08）
- **通用说法**（`genericPlaces` / `resolveGeneric`，任何雪场自动生效）：山顶 = 海拔最高的地点（神乐：かぐら第5ロマンスリフト 下车处，1838 m）；山脚 = 海拔最低的非山顶站；餐厅 = kind restaurant 的地点（有当前位置时取最近）。系统提示里写明对应关系，并要求列举地点时最多两三个。
- **“你知道怎么走吗”卡住**：最可能是文字回声过滤把用户复述雪人的话当成回声丢掉（没有日志，未能确认）。有回声消除后，文字过滤只在播报结束 2 秒内且 85% 以上重合时生效。
- **持久日志**：`FileLog.swift`（`XLog` 替代 NSLog），写 App Documents/logs/xueren-YYYYMMDD.log，保留 7 天；对话逐句记 `[对话]`。取回：`xcrun devicectl device copy from --device <UDID> --domain-type appDataContainer --domain-identifier io.github.williamnatsume.XRSnowNav --source Documents/logs --destination <目录>`（不需要 root，真机验证可用）。
- 真机：实时语音“带我去山顶” → plan_route(山顶) → 对应到第5ロマンス下车处；中级上限下无路线，雪人问是否允许高级道。

#### 自动下载雪场地图（2026-11-08）
- 产品定位（用户明确）：核心是“滑到岔口时告诉我往左还是往右”，加上让一个人滑雪的人觉得有伴、开心。地图准确性是关键。
- **不从滑呗 / Yukiyama / Slopes 抓取**（使用条款、版权）。数据源：OpenStreetMap（ODbL）+ 高程（日本：国土地理院；其他：Open-Meteo Copernicus DEM）。
- `nav/osm-import.js`：转换逻辑从 tools/import-osm.mjs 抽出来的纯函数（Mac 工具和 iPhone 共用）；`elevationPoints` → 原生查高程 → `convertOsm`；`skiAreaQuery` / `parseSkiAreas`（landuse=winter_sports，同名合并、按“在里面 / 距离”排序）；输出 `importReport.quality`（雪道数、有名字的比例、推算连接、未连上的缆车站等）。重新生成的神乐地图与原来逐字一致（除 provenance）。`tests/osm-import.test.mjs` 4 项，共 51 项通过。
- iOS `MapDownloader.swift`：Overpass（两个服务器轮换）→ 高程（GSI 并发 6；Open-Meteo 每次 100 点）→ JS 转换 → `Documents/resorts/osm-<type>-<id>.json`（离线可用，`NavCore.resortText` 优先读这里）。`ResortStore` 列出内置 + 下载的雪场；`covering(lat,lon)` 按 bbox 判断已下载的雪场。
- 自动：真实定位时每 30 分钟 / 移动 3 km 检查一次；在已下载雪场范围内就自动切换，否则查 3 km 内的雪场并下载，雪人说“到XX啦！地图我下好了”。设置里：自动下载开关、“找我附近的雪场”、测试用日本雪场预设、删除下载的地图、当前地图质量。启动参数 `-dlmap "纬度,经度"`。
- Mac 实网测试（苗场）：找到“苗場スキー場（在里面）”，雪道 60 段（92% 有名字）、缆车 14 条；Overpass 公共服务器慢（找雪场 36 s、下载 50 s）。**iPhone 上还没实测**（当时手机锁屏）。
- 数据现状评估：神乐 OSM 雪道 108 段、40% 没名字、15 处推算连接、4 个缆车站端点没连上；几何精度未知。够做原型和实地验证，不够“闭眼信”。下一步：用用户在雪场录的 GPX 核对岔口位置 / 拓扑，无名雪道改用“方向 + 难度 + 通往哪个缆车”来称呼。

#### 地图自动修补（2026-11-08）
- OSM 常见断点：(1) 山脚 / 中转广场没画（雪道终点和缆车下站之间没路）；(2) 缆车站在雪道中段旁边而不是端点旁边；(3) 缆车上站旁边就是另一条缆车下站（换乘），中间没画。
- `nav/osm-import.js` 新增（都有高程判断，生成的边带 `uncertain: true`，note 写明是推算）：
  - 远距离缆车站连接：60 m 内没雪道时扩到 150 m，候选包括雪道中段（插入推算节点、拆分雪道，海拔按两端插值）；往上走不超过 15 m。
  - 广场连接：雪道终点（没有后续雪道）→ 350 m 内、高差 ±12 m 的缆车下站。
  - 换乘连接：缆车上站 → 350 m 内另一条缆车下站（最多上 12 m、下 40 m）。
  - 孤立缆车标记 `isolated`（通用说法“山顶 / 山脚”不选它）；质量报告加 farLiftLinks / plazaLinks / transferLinks / isolatedLifts。
- 效果（任意两缆车站之间可达比例）：神乐 75% → 95%（只剩田代索道下站，从停车场进入，正常），苗场 44% → 100%。神乐山脚 → 山顶：みつまたロープウェイ → みつまた第1高速 → かぐらゴンドラ → かぐら第1高速 → かぐら第5ロマンス（和现实一致）；苗场：火打第1 → プリンス第1ゴンドラ → 筍山。
- 路线经过推算路段时，复述里加“有一段是我推算的连接，到时候留意路牌”；给云端的路线事实里有 `uncertain_segments`。
- 风险：广场 / 换乘连接多（苗场 41 / 4），可能让规划走“地图上没画的平地”；全部标为推算，需用实地 GPX 核对。重新生成了内置神乐地图（109 段）；52 项测试通过；iPhone 上重新下载苗场并用云端对话验证。

#### 导航播报改用实时语音（2026-11-08）
- 用户反馈：和 OpenAI 实时语音说话舒服，导航播报太机械；神乐 / 苗场的播报是日语（导航语言随雪场切成了日语），用户听不懂。
- 有 OpenAI 密钥时：导航语言改用用户说话的语言（`setRealtimeAnnounce`，名称保留原文，实时模型按日语读音读），播报由 `RealtimeSession.announce` 用同一个声音、陪滑口吻说出来（`response.create` + 播报专用 instructions + `tool_choice: none` + `metadata.announce` 对应每条播报）。
- 安全：岔口主提示 / 来不及提示 / 偏航 / 到达是 urgent，会打断正在说的话；“好嘞，进…了”是 low，忙时跳过；1.6 秒没出声改用本机语音；说出来的文字和原文的方向词（左 / 右 / 中间）不一致时本机马上念原文纠正（真机测到过一次被打断后纠正）。提醒提前 1.2 秒（`reactSec` + 1.2），弥补实时语音约 1.5 秒的出声延迟。
- 导航开始时只为播报连上实时语音（不开麦克风，`ensureRealtime(listen: false)`），导航中一直保持连接。
- 没名字的雪道按难度称呼（“中级道 / 中級コース”），不再说“无名雪道”。
- 测试参数 `-simspeed 10`。真机 5× / 10× 模拟测试通过。

#### 用公开 GPS 轨迹核对地图（2026-11-08）
- 数据合规原则（用户确认）：只用自己用户自愿上传的轨迹、OSM 公开轨迹、国土地理院航空照片（注明出处）；**不抓取滑呗 / Yukiyama 等用户发的轨迹图和视频**（版权、平台条款、个人信息）。
- `tools/fetch-osm-traces.mjs`：按 0.02° 小格下载 OSM trackpoints（每页 5000 点、请求间隔 300 ms），原始轨迹只存本机 `data/traces/`（已加入 .gitignore，不提交）。
- `nav/trace-evidence.js`（纯函数，Mac / iPhone 共用）：每条边沿线每 20 m 取样，25 m 内有轨迹点算覆盖；推算连接覆盖 ≥ 50% 视为有轨迹佐证（`applyEvidence` 把 `uncertain` 改为 false，attr.evidence = gps-traces，质量报告加 traceConfirmed）；按 3–30 m/s 找“离地图 45 m 以上的连续快速移动”，`tools/analyze-traces.mjs` 再用国土地理院高程区分滑雪（下降 ≥ 20 m 且坡度 ≥ 5%）和公路。
- 结果：神乐公开轨迹 2738 点 / 25 段，雪道覆盖 3.4 / 36.5 km，推算连接 9 / 25 有佐证（写入地图后 6 处去掉“不确定”）；苗场 6855 点，雪道 43 / 63 段有人滑过，推算连接 55 / 61 有佐证。两地“地图外快速移动”全部是公路（坡度 < 5%），**有轨迹的地方 OSM 没有漏画雪道**。
- `data/osm/kagura-trace-evidence.json`（只有统计，可提交）；`tools/import-osm.mjs` 存在证据文件时自动写入。iPhone 下载地图后也会按小格拉 OSM 公开轨迹核对（最多 40 次请求），失败不影响使用；iPhone 端未实测（当时锁屏）。
- 结论：公开轨迹在热门雪场（苗场）有用，在神乐太稀疏。下一步价值最高的是用户自己的轨迹（自愿上传，按同一套 traceEvidence 分析）；航空照片深度学习是更长期的研究项目。

#### 航空照片核对页（2026-11-08）
- 私有 Artifact「雪人地图核对」：https://claude.ai/artifact/LzvGDQ4kYZJ3bTEbJMf2V4 。国土地理院シームレス空中写真 zoom 17（约 1.2 m/像素）拼成 1024 px 大图随页面发布（Artifact 不能直接加载外部图片）：神乐 56 张、苗场 12 张，约 20 MB。叠加 OSM 雪道（按难度着色）、缆车、推算连接（橙色 = 没人验证，青色 = 有公开轨迹佐证）、岔口（黄圈）。
- 标记存共享存储 `marks`；`tools/apply-review.mjs` 导出 → `data/osm/<雪场>-review.json` → `tools/import-osm.mjs` 用 `nav/review.js` 应用（对的 → 去掉不确定；走不通 → open=false 规划避开；画歪 / 名字 / 缺的路 → 待办）。说明见 `tools/review/README.md`。
- 深度学习识别雪道（用 OSM 雪道当弱标注训练分割模型）是之后的研究项目，先看人工核对发现多少问题再决定。
- 用户反馈（2026-11-08）：人工逐条标注不现实 → 核对页降级为备用工具，改在 App 里放地图。

#### App 内地图（2026-11-08）
- 主界面左上角地图按钮（导航卡片上也有“地图”）→ 全屏地图。`nav/core-entry.js` 新增 `mapData()`（全部边：类型、难度、名字、是否推算 / 关闭、坐标；岔口；POI）和 `mapState(nowMs)`（剩余路线的边、当前位置 / 精度、下一个岔口、目的地）。
- 真实雪场（有经纬度）：`MapScreen.swift` 用 Apple 地图卫星混合底图 + MapPolyline。雪道按难度着色（绿 / 红 / 黑），缆车白色虚线，推算连接橙色点线，黄圈 = 岔口，青色粗线 = 当前路线，蓝点 = 我，闪烁圈 = 下一个岔口，旗子 = 目的地，餐厅标记。导航中打开会自动跟随位置；左上角按钮切换跟随。底部卡片显示当前播报和距岔口距离。
- 虚构演示雪场（局部米制坐标）：Canvas 画示意图。
- 测试参数：`-resort kagura-osm`、`-map`（启动后直接打开地图）。模拟器上神乐 + 虚构雪场截图确认正常；已装到 iPhone，iPhone 上未看。
- 顺带修：① 启动时主线程（选 TTS 声音）和后台（能力自检列声音）同时调用 `AVSpeechSynthesisVoice.speechVoices()` 会在 TextToSpeech 里死锁、整个界面卡死（模拟器必现，真机可能偶发）→ 自检改为在主线程取列表；② 离线规则“去山脚，可以走高级道”认不出泛称目的地 → 修好并加测试（55 个测试通过）。
- 地图和位置、雪人联动（同日，用户要求）：
  - 雪人 → 地图：说“看地图 / 关掉地图”（离线规则 map / mapClose，云端和实时语音用新工具 `show_map`）；雪人规划出新路线（还没出发）时自动弹出地图，青色虚线预览 + 公里数 / 分钟 + “出发 / 不要”按钮（和说“好 / 算了”一样）；同一条路线关掉后不再弹；出发后路线变实线、地图自动跟随。
  - 地图 → 雪人：地图上有麦克风按钮；雪人和用户最近一句话以字幕显示 12 秒；点餐厅 / 缆车站 →“带我去这”，等于说“去 X”。
  - 位置：没在导航时（真实 GPS）底部显示“你在 X 雪道，往下约 N 米有个岔口”（`companion.here()`：匹配所在雪道，沿唯一的下行方向找到第一个岔口），地图上闪烁圈标出；不在雪场范围显示提示。“我在哪”的回答和 get_status 也带上这些。模拟模式没在导航时显示手机自己的定位（MapKit UserAnnotation）。
  - 修：导航结束后地图不再残留旧路线。57 个测试通过；模拟器上截图确认预览 → 出发 → 跟随、说“看看地图”打开；已装 iPhone。真实 GPS 的“你在 X 雪道”只在 node 测试里验证（神乐坐标），没在雪场实测。

## 5. Mac 开工步骤（给 Mac 上的 Claude Code）

用户会授权较宽的权限，但以下事项**必须由用户亲自完成**，不要尝试代替：输入 Apple ID 密码 / 两步验证码、输入 macOS 管理员密码（sudo）、在 iPhone 上点“信任”和开启开发者模式、在 Xcode 界面选择签名团队。

### 5.1 环境检查
```bash
sw_vers                 # macOS 版本
uname -m                # 应为 arm64（Apple 芯片）
df -h ~                 # 剩余空间，需要 60 GB 以上
xcode-select -p         # 是否已有 Xcode / 命令行工具
which brew node git
```

### 5.2 自动安装 Xcode（尽量自动，需要用户配合的地方先说明再执行）
1. 安装 Homebrew（如果没有）：运行官方安装脚本；过程中需要用户输入 macOS 密码。
2. `brew install node mas`（node 用于 `npm test` 和打包；mas 是 Mac App Store 命令行工具）。
3. 让用户在 App Store 应用里登录自己的 Apple ID（只能由用户操作）。
4. 安装 Xcode（App Store id 497799835）：先试 `mas install 497799835`；如果 mas 无法获取未购买过的免费应用，就执行 `open "macappstore://apps.apple.com/app/id497799835"` 打开页面，请用户点“获取”。下载很大（十几 GB），用 `ls /Applications/Xcode.app` 轮询等待完成。
5. 完成后（以下 sudo 需要用户输入密码）：
   ```bash
   sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
   sudo xcodebuild -license accept
   xcodebuild -runFirstLaunch
   xcodebuild -downloadPlatform iOS      # 下载 iOS 平台和模拟器
   ```
6. 让用户打开 Xcode → Settings → Accounts 登录 Apple ID（个人团队）。

### 5.3 代码与 GitHub
```bash
git clone https://github.com/williamnatsume/xr-snow.git
cd xr-snow && npm test
```
推送时 Git 会弹出浏览器让用户登录 GitHub（用户操作）。

### 5.4 连接 iPhone
用数据线连接 → iPhone 上点“信任” → 设置 → 隐私与安全性 → 开发者模式 → 打开（会重启）。第一次装 App 后：设置 → 通用 → VPN 与设备管理 → 信任开发者。

### 5.5 然后开始第 4 节的 M1

### 5.6 这台 Mac 的实际情况（2026-11-04 记录）
- 原为 macOS 15.1.1，装不了 Xcode 27（需要 macOS 26.6 以上，iPhone 18 / iOS 27 真机需要 Xcode 27）→ 用户已升级到 **macOS 27.2**；现为 **Xcode 27.2**。
- 终端账号是 `wly`（`$HOME` = `/Users/wly`），但 Claude Code 的工作文件夹是 `/Users/zhy`：仓库在 **`/Users/zhy/dev/xr-snow`**。命令里不要用 `~` 指代仓库位置。
- Homebrew **没有装成**（安装脚本需要 sudo 密码，未完成）。Node 26 LTS 直接从 nodejs.org 解压到 `$HOME/.local/node`（已核对 SHA-256）；用前 `export PATH=$HOME/.local/node/bin:$PATH`。
- Xcode 是用户在 App Store 里点“获取”装的；iOS 27.2 模拟器用 `xcodebuild -downloadPlatform iOS` 下载（约 8.3 GB）。
- npm 11 默认不跑安装脚本：esbuild 会提示 postinstall 被跳过，但不影响使用（平台二进制已装上）。

## 6. 硬件备忘

- Micro-OLED 模组只接受 640×400 / 640×480（用户记忆，未用 EDID 核实）。iPhone 13 Pro + 第三方 Lightning-HDMI 转接头输出 1080p/720p → 模组蓝屏。
- 方案选项：HDMI 缩放盒降到 640×480；iPhone 15 及以后为 USB-C，可直接 USB-C 转 HDMI，但仍是 1080p 镜像，分辨率问题同样存在；长期方向是小电脑板直接驱动模组，或带蓝牙的一体化模组（考虑向 JBD 询价，MicroLED 亮度高、多为单色绿）。
- iPhone Safari 不支持 Web Bluetooth；蓝牙方案需要原生 App（与第 4 节的 App 合并）。

## 7. 约定

- 代码注释、界面、文档用中文。
- 提交信息结尾加：`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
- 发布：推送到 `main` 即自动更新 GitHub Pages（也可以双击 Windows 上的 `发布.bat`）。新页面或新数据源公开前先问用户。
- 汇报方式：先结论；写清楚做了什么、怎么验证的、哪些没验证。不编造雪道数据，未核实的属性不能标成已核实。
- 雪场数据可信度标签：`demo` / `unknown` / `osm` / `derived` / `conflict` / `verified`。
