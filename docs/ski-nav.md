# 雪场语音导航 MVP

在接近雪道岔口之前，用语音告诉用户该走哪个分支。第一版只验证“路线规划 + 定位判断 + 及时语音提示”，不接 AR 眼镜、不做硬件、不做找朋友。

## 启动

```bash
cd "XR SNOW"
npm start            # = node tools/serve.mjs，打开 http://localhost:8080/ski-nav.html
npm test             # 27 项自动测试（node --test）
npm run import:kagura   # 重新从 OSM 数据生成 resorts/kagura-osm.json
```

- 页面需要读取 `resorts/*.json`，所以要用本地服务器或 GitHub Pages 打开，直接双击 HTML 不行。
- 手机（iPhone）要用真实 GPS，必须走 HTTPS：推送后打开 `https://williamnatsume.github.io/xr-snow/ski-nav.html`。

## 结构（分层）

| 层 | 文件 | 说明 |
|---|---|---|
| 地图数据 | `resorts/*.json`、`nav/resort.js` | 可替换的 JSON；载入时校验并统一投影到米制坐标 |
| 路线规划 | `nav/planner.js` | 有向图 + Dijkstra；硬性约束 / 软偏好；无路线时只诊断不放宽 |
| 指令 | `nav/instructions.js` | 只根据路线和地图生成；左右按“进入方向 vs 离开方向”计算 |
| 定位匹配 | `nav/matcher.js` | 用位置轨迹判断所在雪道；行进方向取最近约 35 m 位移 |
| 导航状态机 | `nav/navigator.js` | 状态、播报时机、去重、通过确认、偏航、定位可靠性 |
| 定位来源 | `nav/simulator.js`、`nav/position.js` | 模拟器 / 浏览器 GPS，输出统一格式的定位点 |
| 语音 | `nav/voice.js` | 浏览器语音合成；同样接口可换成原生 iOS |
| 自然语言 | `nav/nlp.js` | 本地规则 → 结构化条件；不决定雪道和转弯 |
| 界面 | `ski-nav.html`、`nav/app.js`、`nav/mapview.js` | SVG 示意图，不依赖在线地图 |

导航状态：未开始 → 导航中 ⇄ 接近岔口 → 通过待确认 → 已通过 → … → 到达；随时可能进入“偏离路线”或“定位不可靠”（定位中断 / 精度不足 / 相邻雪道无法区分）。另有“已暂停”。

## 雪场 JSON 格式（`xrsnow.resort/1`）

```jsonc
{
  "schema": "xrsnow.resort/1",
  "id": "...", "name": "...",
  "dataStatus": "fictional | unverified | verified",
  "allowRealGps": false,                 // 虚构雪场必须为 false；载入时也会强制检查
  "disclaimer": "...",
  "crs": { "type": "local-meters" | "wgs84" },   // local-meters: [x,y] 米；wgs84: [lat,lon]
  "nodes": [{ "id", "name", "kind", "pos", "ele", "attr": { "pos": "demo|osm|derived|verified" } }],
  "edges": [{
    "id", "type": "run | lift | connector",
    "from", "to",                        // 只能按 from → to 通行（雪道 = 下坡方向，缆车 = 上行方向）
    "geometry": [[..],[..]],             // 折线，方向与通行方向一致
    "ref": "5", "name": "中央线", "sign": "5 中央线",   // 编号 / 名称 / 路牌文字
    "difficulty": 1-4 | null, "open": true | false | null, "flat": true | false | null,
    "width_m": 30,
    "attr": { "difficulty": "...", "open": "...", "flat": "...", "direction": "...", "geometry": "...", "name": "..." }
  }],
  "pois": [{ "id", "name", "name_ja", "node", "kind", "aliases": [] }]
}
```

`attr` 的取值：`demo` 演示（虚构）/ `unknown` 未知 / `osm` 来自 OSM 未核实 / `derived` 程序推算未核实 / `conflict` 数据矛盾 / `verified` 已核实。界面的调试面板里会逐段显示。

## 可调阈值（都是待实测的初始值）

`nav/navigator.js` 的 `NAV_CFG`、`nav/matcher.js` 的 `MATCH_CFG`、`nav/instructions.js` 的 `INSTR_CFG`、`nav/planner.js` 的 `COST`。

主提示距离 = 速度 ×（预计语音时长 + 反应时间 4 s）+ 定位误差 + 余量 25 m，至少 40 m；预告再提前 15 秒（至少 150 m）。语音时长按中文约 4.2 字/秒估算。

## 神乐数据（`resorts/kagura-osm.json`）

由 `tools/import-osm.mjs` 从 OpenStreetMap（© OpenStreetMap contributors，ODbL）生成，高程来自国土地理院 標高API。

- **来自 OSM，未核实**：雪道和缆车的几何、名称、难度；雪道方向按 OSM 约定（按下坡方向画）。
- **程序推算**：雪道方向已用高程检查，0 段矛盾；平路按两端高程算平均坡度 < 6%；另有 3 处雪道端点吸附、5 处缆车站步行连接、7 处步行连接（例如かぐらゴンドラ下车处 ↔ かぐらメインゲレンデ末端 75 m）。
- **未知**：所有雪道和缆车的开放状态。
- **缺失**：みつまたロープウェイ两端没有连接到雪道；不少雪道在 OSM 上没有名称；没有路牌编号。
