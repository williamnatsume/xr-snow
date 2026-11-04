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
| 原生 iOS App | 🟡 M1 进行中：工程可编译（iphoneos SDK，未签名）；模拟器运行与自检待验证（见第 4 节） | `ios/XRSnowNav` |
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
  - Bundle ID `io.github.williamnatsume.XRSnowNav`，签名团队为空：真机安装前在 Xcode → Signing & Capabilities 里选个人团队（用户操作）。

命令行编译检查（不需要签名）：

```bash
cd ios/XRSnowNav && xcodebuild -project XRSnowNav.xcodeproj -target XRSnowNav -sdk iphoneos CODE_SIGNING_ALLOWED=NO build
```

### 已知风险
- 免费个人团队下某些能力（如推送）不可用；Background Modes（定位、音频）应可用，如不行再升级付费账号。
- 后台长时间定位耗电大，低温下更明显：需要实测。
- 神乐 OSM 数据未核实：开放状态全部未知，15 处连接为程序推算，みつまたロープウェイ未连通。

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
