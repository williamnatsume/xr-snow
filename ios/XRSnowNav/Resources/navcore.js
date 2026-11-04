// 自动生成，请勿手改：npm run build:ios（源码在 nav/）
var XRNav = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // nav/core-entry.js
  var core_entry_exports = {};
  __export(core_entry_exports, {
    DEFAULT_PREFS: () => DEFAULT_PREFS,
    INTENT_SCHEMA: () => INTENT_SCHEMA,
    Navigator: () => Navigator,
    STATE_ZH: () => STATE_ZH,
    Simulator: () => Simulator,
    UNRELIABLE_ZH: () => UNRELIABLE_ZH,
    WAKE_WORDS: () => WAKE_WORDS,
    buildManeuvers: () => buildManeuvers,
    createCompanion: () => createCompanion,
    createSession: () => createSession,
    loadResort: () => loadResort,
    maneuverText: () => maneuverText,
    parseRequest: () => parseRequest,
    planRoute: () => planRoute,
    rulesIntent: () => rulesIntent,
    runScenario: () => runScenario,
    scenarioTexts: () => scenarioTexts
  });

  // nav/geo.js
  var R = 6371e3;
  var RAD = Math.PI / 180;
  function makeProjection(lat0, lon0) {
    const kx = Math.cos(lat0 * RAD) * R * RAD;
    const ky = R * RAD;
    return {
      lat0,
      lon0,
      toXY: (lat, lon) => ({ x: (lon - lon0) * kx, y: (lat - lat0) * ky }),
      toLatLon: (x, y) => ({ lat: lat0 + y / ky, lon: lon0 + x / kx })
    };
  }
  var dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
  function bearing(a, b) {
    const deg = Math.atan2(b.x - a.x, b.y - a.y) / RAD;
    return (deg + 360) % 360;
  }
  function angleDiff(to, from) {
    let d = ((to - from) % 360 + 360) % 360;
    if (d > 180) d -= 360;
    return d;
  }
  function cumulative(pts) {
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]));
    return cum;
  }
  function projectToPolyline(p, pts, cum) {
    let best = null;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy;
      const t = L2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2)) : 0;
      const qx = a.x + dx * t, qy = a.y + dy * t;
      const d = Math.hypot(p.x - qx, p.y - qy);
      if (!best || d < best.d) {
        const cross = dx * (p.y - a.y) - dy * (p.x - a.x);
        best = { d, s: cum[i] + Math.sqrt(L2) * t, seg: i, heading: bearing(a, b), side: cross > 0 ? -1 : 1, point: { x: qx, y: qy } };
      }
    }
    return best;
  }
  function pointAt(pts, cum, s) {
    if (s <= 0) return { ...pts[0], heading: bearing(pts[0], pts[1]) };
    const total = cum[cum.length - 1];
    if (s >= total) return { ...pts[pts.length - 1], heading: bearing(pts[pts.length - 2], pts[pts.length - 1]) };
    let i = 1;
    while (cum[i] < s) i++;
    const a = pts[i - 1], b = pts[i];
    const t = (s - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, heading: bearing(a, b) };
  }
  function headingNearStart(pts, cum, len = 40) {
    const p = pointAt(pts, cum, Math.min(len, cum[cum.length - 1]));
    return bearing(pts[0], p);
  }
  function headingNearEnd(pts, cum, len = 40) {
    const total = cum[cum.length - 1];
    const p = pointAt(pts, cum, Math.max(0, total - len));
    return bearing(p, pts[pts.length - 1]);
  }
  function seededRandom(seed = 1) {
    let s = seed >>> 0 || 1;
    return () => {
      s ^= s << 13;
      s >>>= 0;
      s ^= s >> 17;
      s ^= s << 5;
      s >>>= 0;
      return s / 4294967296;
    };
  }
  function gaussian(rand) {
    const u = Math.max(1e-12, rand()), v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  // nav/resort.js
  var DIFFICULTY = {
    1: { zh: "\u521D\u7EA7", ja: "\u521D\u7D1A", color: "#2ea44f" },
    2: { zh: "\u4E2D\u7EA7", ja: "\u4E2D\u7D1A", color: "#e5484d" },
    3: { zh: "\u9AD8\u7EA7", ja: "\u4E0A\u7D1A", color: "#e8e8e8" },
    4: { zh: "\u4E13\u5BB6\u7EA7", ja: "\u30A8\u30AD\u30B9\u30D1\u30FC\u30C8", color: "#a78bfa" }
  };
  function loadResort(json) {
    const errors = [], warnings = [];
    if (!json || json.schema !== "xrsnow.resort/1") errors.push("\u4E0D\u662F xrsnow.resort/1 \u683C\u5F0F\u7684\u96EA\u573A\u6587\u4EF6");
    const crs = json.crs?.type;
    if (crs !== "local-meters" && crs !== "wgs84") errors.push("crs.type \u5FC5\u987B\u662F local-meters \u6216 wgs84");
    if (errors.length) return { errors, warnings };
    let proj = null;
    if (crs === "wgs84") {
      const lats = json.nodes.map((n) => n.pos[0]), lons = json.nodes.map((n) => n.pos[1]);
      proj = makeProjection((Math.min(...lats) + Math.max(...lats)) / 2, (Math.min(...lons) + Math.max(...lons)) / 2);
    }
    const toXY = (p) => proj ? proj.toXY(p[0], p[1]) : { x: p[0], y: p[1] };
    const nodes = /* @__PURE__ */ new Map();
    for (const n of json.nodes || []) {
      if (nodes.has(n.id)) errors.push(`\u8282\u70B9 id \u91CD\u590D\uFF1A${n.id}`);
      nodes.set(n.id, { ...n, ...toXY(n.pos) });
    }
    const edges = /* @__PURE__ */ new Map();
    const out = /* @__PURE__ */ new Map(), inc = /* @__PURE__ */ new Map();
    for (const n of nodes.keys()) {
      out.set(n, []);
      inc.set(n, []);
    }
    for (const e of json.edges || []) {
      if (edges.has(e.id)) {
        errors.push(`\u96EA\u9053 id \u91CD\u590D\uFF1A${e.id}`);
        continue;
      }
      if (!nodes.has(e.from) || !nodes.has(e.to)) {
        errors.push(`${e.id}\uFF1A\u8D77\u70B9\u6216\u7EC8\u70B9\u8282\u70B9\u4E0D\u5B58\u5728`);
        continue;
      }
      if (!["run", "lift", "connector"].includes(e.type)) {
        errors.push(`${e.id}\uFF1Atype \u5FC5\u987B\u662F run / lift / connector`);
        continue;
      }
      const pts = (e.geometry || []).map(toXY);
      if (pts.length < 2) {
        errors.push(`${e.id}\uFF1A\u6298\u7EBF\u81F3\u5C11\u9700\u8981 2 \u4E2A\u70B9`);
        continue;
      }
      const a = nodes.get(e.from), b = nodes.get(e.to);
      if (dist(pts[0], a) > 30 || dist(pts[pts.length - 1], b) > 30) {
        warnings.push(`${e.id}\uFF1A\u6298\u7EBF\u7AEF\u70B9\u4E0E\u8282\u70B9\u76F8\u8DDD\u8D85\u8FC7 30 m\uFF0C\u68C0\u67E5\u65B9\u5411\u662F\u5426\u753B\u53CD`);
      }
      const cum = cumulative(pts);
      const edge = {
        ...e,
        pts,
        cum,
        length: cum[cum.length - 1],
        headStart: headingNearStart(pts, cum),
        headEnd: headingNearEnd(pts, cum),
        attr: e.attr || {}
      };
      if (e.length_m && Math.abs(e.length_m - edge.length) > Math.max(20, e.length_m * 0.1)) {
        warnings.push(`${e.id}\uFF1A\u6807\u6CE8\u957F\u5EA6 ${e.length_m} m \u4E0E\u6298\u7EBF\u957F\u5EA6 ${Math.round(edge.length)} m \u4E0D\u4E00\u81F4\uFF0C\u4EE5\u6298\u7EBF\u4E3A\u51C6`);
      }
      if (e.type === "run") {
        const ea = a.ele, eb = b.ele;
        if (ea != null && eb != null && eb > ea + 3) warnings.push(`${e.id}\uFF1A\u7EC8\u70B9\u6BD4\u8D77\u70B9\u9AD8\uFF0C\u96EA\u9053\u65B9\u5411\u53EF\u80FD\u6709\u8BEF`);
      }
      edges.set(e.id, edge);
      out.get(e.from).push(edge);
      inc.get(e.to).push(edge);
    }
    const pois = (json.pois || []).filter((p) => {
      if (!nodes.has(p.node)) {
        warnings.push(`\u76EE\u7684\u5730 ${p.name} \u6307\u5411\u4E0D\u5B58\u5728\u7684\u8282\u70B9 ${p.node}`);
        return false;
      }
      return true;
    });
    return {
      errors,
      warnings,
      id: json.id,
      name: json.name,
      region: json.region,
      disclaimer: json.disclaimer,
      dataStatus: json.dataStatus,
      // fictional / unverified / verified
      allowRealGps: json.allowRealGps === true && json.dataStatus !== "fictional" && crs === "wgs84",
      provenance: json.provenance || {},
      importReport: json.importReport,
      crs,
      proj,
      nodes,
      edges,
      out,
      in: inc,
      pois,
      raw: json
    };
  }
  function edgeLabel(e) {
    if (!e) return "";
    const kind = e.type === "lift" ? "\u7F06\u8F66" : e.type === "connector" ? "\u6B65\u9053" : "\u96EA\u9053";
    if (e.ref && e.name) return `${e.ref}\u53F7${kind}\u300C${e.name}\u300D`;
    if (e.ref) return `${e.ref}\u53F7${kind}`;
    if (e.name) return e.name;
    return e.type === "run" ? `\u65E0\u540D\u96EA\u9053\uFF08${e.id}\uFF09` : `\u65E0\u540D${kind}\uFF08${e.id}\uFF09`;
  }
  function poiOfNode(resort, nodeId) {
    return resort.pois.find((p) => p.node === nodeId) || null;
  }

  // nav/planner.js
  var DEFAULT_PREFS = {
    maxDifficulty: 2,
    // 1 初级 / 2 中级 / 3 高级 / 4 专家
    avoidFlat: false,
    preferShort: false,
    allowUnknownDifficulty: false,
    // 难度未知的雪道默认不进入
    allowUnknownOpen: true
    // 开放状态未知（真实数据一律未知）默认允许，但会给出警告
  };
  var COST = {
    runSpeed: { 1: 5.5, 2: 7, 3: 8, 4: 8 },
    // m/s，按难度估计的平均滑行速度
    flatSpeed: 2.5,
    // 平路（蹬行）m/s
    walkSpeed: 1.2,
    // 步道 m/s
    liftSpeed: 4,
    // 没有乘坐时间数据时按 4 m/s 估算
    liftWait: 180,
    // 每次乘缆车估计排队 + 上下车 3 分钟
    flatPenalty: 4
    // 避开平路时，平路段代价 × 4
  };
  function edgeBlockReason(e, prefs) {
    if (e.open === false) return e.type === "lift" ? "\u7F06\u8F66\u505C\u8FD0" : "\u96EA\u9053\u5173\u95ED";
    if (e.open == null && !prefs.allowUnknownOpen) return "\u5F00\u653E\u72B6\u6001\u672A\u77E5";
    if (e.directionCheck === "conflict") return "\u65B9\u5411\u6570\u636E\u77DB\u76FE";
    if (e.type === "lift") return null;
    if (e.difficulty == null) return prefs.allowUnknownDifficulty ? null : "\u96BE\u5EA6\u672A\u77E5";
    if (e.difficulty > prefs.maxDifficulty) return "\u8D85\u8FC7\u96BE\u5EA6\u4E0A\u9650";
    return null;
  }
  function edgeTime(e) {
    if (e.type === "lift") return (e.duration_min ? e.duration_min * 60 : e.length / COST.liftSpeed) + COST.liftWait;
    if (e.type === "connector") return e.length / COST.walkSpeed;
    if (e.flat === true) return e.length / COST.flatSpeed;
    return e.length / (COST.runSpeed[e.difficulty] || COST.runSpeed[2]);
  }
  function edgeCost(e, prefs) {
    let c = prefs.preferShort ? e.length : edgeTime(e);
    if (prefs.avoidFlat && e.flat === true) c *= COST.flatPenalty;
    return c;
  }
  var Heap = class {
    constructor() {
      this.a = [];
    }
    push(x) {
      const a = this.a;
      a.push(x);
      let i = a.length - 1;
      while (i > 0) {
        const p = i - 1 >> 1;
        if (a[p].k <= a[i].k) break;
        [a[p], a[i]] = [a[i], a[p]];
        i = p;
      }
    }
    pop() {
      const a = this.a, top = a[0], last = a.pop();
      if (a.length) {
        a[0] = last;
        let i = 0;
        for (; ; ) {
          const l = 2 * i + 1, r = l + 1;
          let m = i;
          if (l < a.length && a[l].k < a[m].k) m = l;
          if (r < a.length && a[r].k < a[m].k) m = r;
          if (m === i) break;
          [a[m], a[i]] = [a[i], a[m]];
          i = m;
        }
      }
      return top;
    }
    get size() {
      return this.a.length;
    }
  };
  function dijkstra(resort, startNode, goalNode, prefs) {
    const best = /* @__PURE__ */ new Map([[startNode, 0]]);
    const prev = /* @__PURE__ */ new Map();
    const heap = new Heap();
    heap.push({ k: 0, n: startNode });
    while (heap.size) {
      const { k, n: n2 } = heap.pop();
      if (n2 === goalNode) break;
      if (k > best.get(n2)) continue;
      for (const e of resort.out.get(n2) || []) {
        if (edgeBlockReason(e, prefs)) continue;
        const nk = k + edgeCost(e, prefs);
        if (nk < (best.get(e.to) ?? Infinity)) {
          best.set(e.to, nk);
          prev.set(e.to, e);
          heap.push({ k: nk, n: e.to });
        }
      }
    }
    if (!best.has(goalNode)) return null;
    const edges = [];
    let n = goalNode;
    while (n !== startNode) {
      const e = prev.get(n);
      edges.unshift(e);
      n = e.from;
    }
    return { edges, cost: best.get(goalNode) };
  }
  function summarize(resort, edges, prefs) {
    const warnings = [];
    let length = 0, time = 0, flatLen = 0, liftCount = 0, maxDiff = 0;
    for (const e of edges) {
      length += e.length;
      time += edgeTime(e);
      if (e.flat === true) flatLen += e.length;
      if (e.type === "lift") liftCount++;
      if (e.type !== "lift" && e.difficulty) maxDiff = Math.max(maxDiff, e.difficulty);
    }
    if (edges.some((e) => e.open == null)) warnings.push("\u8DEF\u7EBF\u4E2D\u6709\u5F00\u653E\u72B6\u6001\u672A\u77E5\u7684\u96EA\u9053/\u7F06\u8F66\uFF0C\u51FA\u53D1\u524D\u8BF7\u786E\u8BA4\u73B0\u573A\u5F00\u653E\u60C5\u51B5");
    if (edges.some((e) => e.type !== "lift" && e.flat == null)) warnings.push("\u90E8\u5206\u8DEF\u6BB5\u662F\u5426\u4E3A\u5E73\u8DEF\u672A\u77E5");
    if (prefs.avoidFlat && flatLen > 0) warnings.push(`\u5DF2\u5C3D\u91CF\u907F\u5F00\u5E73\u8DEF\uFF0C\u4F46\u4ECD\u6709\u7EA6 ${Math.round(flatLen)} m \u5E73\u8DEF\u65E0\u6CD5\u7ED5\u5F00`);
    if (edges.some((e) => e.attr?.geometry === "derived")) warnings.push("\u90E8\u5206\u8FDE\u63A5\u6BB5\u662F\u7A0B\u5E8F\u63A8\u7B97\u7684\uFF0C\u5B9E\u9645\u8DEF\u5F84\u53EF\u80FD\u4E0D\u540C");
    return { length, time, flatLen, liftCount, maxDiff, warnings };
  }
  function planRoute(resort, { startNode, startEdgeId, goalNode }, prefs = DEFAULT_PREFS) {
    prefs = { ...DEFAULT_PREFS, ...prefs };
    let prefix = [];
    let from = startNode;
    if (startEdgeId) {
      const cur = resort.edges.get(startEdgeId);
      if (!cur) return { ok: false, reason: "\u5F53\u524D\u6240\u5728\u8DEF\u6BB5\u4E0D\u5B58\u5728" };
      prefix = [cur];
      from = cur.to;
    }
    if (!resort.nodes.has(from) || !resort.nodes.has(goalNode)) return { ok: false, reason: "\u8D77\u70B9\u6216\u76EE\u7684\u5730\u4E0D\u5B58\u5728" };
    if (from === goalNode) {
      if (prefix.length) return { ok: true, edges: prefix, ...summarize(resort, prefix, prefs), prefs };
      return { ok: false, reason: "\u8D77\u70B9\u548C\u76EE\u7684\u5730\u76F8\u540C" };
    }
    const r = dijkstra(resort, from, goalNode, prefs);
    if (r) {
      const edges = [...prefix, ...r.edges];
      return { ok: true, edges, ...summarize(resort, edges, prefs), prefs };
    }
    const hints = [];
    const tryWith = (p, text) => {
      if (dijkstra(resort, from, goalNode, { ...prefs, ...p })) hints.push(text);
    };
    if (prefs.maxDifficulty < 4) {
      for (let d = prefs.maxDifficulty + 1; d <= 4; d++) {
        if (dijkstra(resort, from, goalNode, { ...prefs, maxDifficulty: d })) {
          hints.push(`\u5982\u679C\u5141\u8BB8${["", "\u521D\u7EA7", "\u4E2D\u7EA7", "\u9AD8\u7EA7", "\u4E13\u5BB6\u7EA7"][d]}\u96EA\u9053\u5219\u53EF\u4EE5\u5230\u8FBE`);
          break;
        }
      }
    }
    if (!prefs.allowUnknownDifficulty) tryWith({ allowUnknownDifficulty: true, maxDifficulty: 4 }, "\u90E8\u5206\u53EF\u80FD\u7684\u8DEF\u7EBF\u7ECF\u8FC7\u96BE\u5EA6\u672A\u77E5\u7684\u96EA\u9053");
    const anyOpen = dijkstra(resort, from, goalNode, { maxDifficulty: 4, allowUnknownDifficulty: true, allowUnknownOpen: true, avoidFlat: false, preferShort: true });
    if (!anyOpen && !hints.length) hints.push("\u5373\u4F7F\u4E0D\u9650\u96BE\u5EA6\u4E5F\u6CA1\u6709\u8FDE\u901A\u8DEF\u7EBF\uFF1A\u53EF\u80FD\u5FC5\u987B\u7ECF\u8FC7\u5173\u95ED\u7684\u96EA\u9053\uFF0C\u6216\u5730\u56FE\u6570\u636E\u7F3A\u5931");
    return {
      ok: false,
      reason: "\u5728\u5F53\u524D\u6761\u4EF6\u4E0B\u6CA1\u6709\u53EF\u7528\u8DEF\u7EBF\uFF08\u672A\u81EA\u52A8\u653E\u5BBD\u6761\u4EF6\uFF09",
      hints,
      prefs
    };
  }

  // nav/instructions.js
  var INSTR_CFG = {
    behindDeg: 120,
    // 与来路方向夹角超过 120° 的分支视为“身后”，不算作岔口选项
    unclearDeg: 12,
    // 选中分支与相邻分支方向差小于 12° 时，不说左右，只说路牌名称
    mergeWithinM: 60
    // 两个岔口相距小于 60 m 时合并成一条提示（待实测）
  };
  var ZH_NUM = ["\u96F6", "\u4E00", "\u4E8C", "\u4E09", "\u56DB", "\u4E94", "\u516D", "\u4E03", "\u516B", "\u4E5D", "\u5341"];
  function zhNumber(ref) {
    const n = Number(ref);
    if (!Number.isInteger(n) || n < 0 || n > 99) return String(ref);
    if (n <= 10) return ZH_NUM[n];
    if (n < 20) return "\u5341" + ZH_NUM[n - 10];
    return ZH_NUM[Math.floor(n / 10)] + "\u5341" + (n % 10 ? ZH_NUM[n % 10] : "");
  }
  function spokenName(e, lang = "zh") {
    if (!e) return "";
    if (lang === "ja") {
      const kind2 = e.type === "lift" ? "" : e.type === "connector" ? "\u9023\u7D61\u8DEF" : "\u30B3\u30FC\u30B9";
      if (e.ref) return `${e.ref}\u756A${e.type === "lift" ? "\u30EA\u30D5\u30C8" : kind2}`;
      if (e.type === "connector" && e.attr?.geometry === "derived") return "\u9023\u7D61\u8DEF";
      if (e.name) return e.name;
      return e.type === "run" ? "\u540D\u524D\u306E\u306A\u3044\u30B3\u30FC\u30B9" : "\u9023\u7D61\u8DEF";
    }
    const kind = e.type === "lift" ? "\u7F06\u8F66" : e.type === "connector" ? "\u6B65\u9053" : "\u96EA\u9053";
    if (e.ref) return `${zhNumber(e.ref)}\u53F7${kind}`;
    if (e.type === "connector" && e.attr?.geometry === "derived") return "\u6B65\u9053";
    if (e.name) return e.name;
    return e.type === "run" ? "\u65E0\u540D\u96EA\u9053" : "\u6B65\u9053";
  }
  var SIDE = {
    zh: { left: "\u9760\u5DE6", right: "\u9760\u53F3", middle: "\u8D70\u4E2D\u95F4", unclear: "" },
    ja: { left: "\u5DE6\u3078", right: "\u53F3\u3078", middle: "\u771F\u3093\u4E2D\u3078", unclear: "" }
  };
  function forkSide(inEdge, chosen, alternatives) {
    const hin = inEdge.headEnd;
    const opts = [chosen, ...alternatives].map((e) => ({ e, rel: angleDiff(e.headStart, hin) })).filter((o) => o.e === chosen || Math.abs(o.rel) <= INSTR_CFG.behindDeg);
    const others = opts.filter((o) => o.e !== chosen);
    const relC = opts.find((o) => o.e === chosen).rel;
    if (!others.length) return { side: "none", rel: relC, options: opts };
    const minGap = Math.min(...others.map((o) => Math.abs(o.rel - relC)));
    let side;
    if (minGap < INSTR_CFG.unclearDeg) side = "unclear";
    else if (others.every((o) => o.rel > relC)) side = "left";
    else if (others.every((o) => o.rel < relC)) side = "right";
    else side = "middle";
    return { side, rel: relC, minGap, options: opts.map((o) => ({ id: o.e.id, rel: Math.round(o.rel) })) };
  }
  function buildManeuvers(resort, edges, destNodeId) {
    const dest = poiOfNode(resort, destNodeId);
    const destName = dest ? dest.name : resort.nodes.get(destNodeId)?.name || "\u76EE\u7684\u5730";
    const destNameJa = dest ? dest.name_ja || dest.name : destName;
    const list = [];
    let cumStart = 0;
    for (let k = 0; k < edges.length; k++) {
      const e = edges[k];
      const endAlong = cumStart + e.length;
      if (k < edges.length - 1) {
        const next = edges[k + 1];
        const alternatives = (resort.out.get(e.to) || []).filter((x) => x !== next);
        let type, sideInfo = null;
        if (next.type === "lift") type = "board-lift";
        else if (e.type === "lift") {
          type = "exit-lift";
          sideInfo = forkSide(e, next, alternatives);
        } else {
          sideInfo = forkSide(e, next, alternatives);
          type = sideInfo.side === "none" ? "continue" : "fork";
        }
        list.push({
          id: `M${k}:${e.to}`,
          index: k,
          // 在第 k 条边的末端
          nodeId: e.to,
          type,
          side: sideInfo?.side || "none",
          sideInfo,
          inEdge: e,
          outEdge: next,
          alternatives,
          along: endAlong,
          // 从路线起点算起的沿路距离
          destName,
          destNameJa,
          announce: type !== "continue"
        });
      } else {
        list.push({ id: `A:${e.to}`, index: k, nodeId: e.to, type: "arrive", side: "none", inEdge: e, outEdge: null, alternatives: [], along: endAlong, destName, destNameJa, announce: true });
      }
      cumStart = endAlong;
    }
    const ann = list.filter((m) => m.announce && m.type !== "arrive");
    for (let i = 0; i < ann.length - 1; i++) {
      const a = ann[i], b = ann[i + 1];
      if (b.along - a.along < INSTR_CFG.mergeWithinM && (a.type === "fork" || a.type === "exit-lift") && b.type === "fork") a.then = b;
    }
    for (const m of list) m.sameRun = !!(m.outEdge && m.inEdge && m.outEdge.name && m.outEdge.name === m.inEdge.name);
    return list;
  }
  function maneuverText(m, kind, { lang = "zh", distance = null } = {}) {
    const S = SIDE[lang] || SIDE.zh;
    const side = S[m.side] || "";
    const out = m.outEdge ? spokenName(m.outEdge, lang) : "";
    const meters = distance != null ? Math.max(50, Math.round(distance / 50) * 50) : null;
    const then = m.then ? S[m.then.side] || "" : "";
    const thenOut = m.then ? spokenName(m.then.outEdge, lang) : "";
    if (lang === "ja") {
      m = { ...m, destName: m.destNameJa || m.destName };
      const go2 = m.sameRun ? `${out}\u3092\u305D\u306E\u307E\u307E\u9032\u3093\u3067\u304F\u3060\u3055\u3044` : `${out}\u306B\u9032\u3093\u3067\u304F\u3060\u3055\u3044`;
      const thenJa = m.then ? `\u3002\u7D9A\u3051\u3066${then}${thenOut}\u3078` : "";
      switch (m.type) {
        case "fork":
          if (kind === "preview") return `\u304A\u3088\u305D${meters}\u30E1\u30FC\u30C8\u30EB\u5148\u3001\u5206\u5C90\u3067\u3059\u3002${side}${out}\u306B\u9032\u307F\u307E\u3059${thenJa}`;
          if (kind === "late") return side ? `${side}\u3001${out}` : `${out}\u3078`;
          if (kind === "confirm") return `${out}\u306B\u5165\u308A\u307E\u3057\u305F`;
          return side ? `\u3053\u306E\u5148\u5206\u5C90\u3001${side}\u3001${go2}${thenJa}\u3002${m.destName}\u65B9\u9762\u3067\u3059` : `\u3053\u306E\u5148\u5206\u5C90\u3001\u6848\u5185\u677F\u306B\u5F93\u3063\u3066${go2}${thenJa}`;
        case "exit-lift":
          if (kind === "confirm") return `${out}\u306B\u5165\u308A\u307E\u3057\u305F`;
          return side ? `\u30EA\u30D5\u30C8\u3092\u964D\u308A\u305F\u3089\u3001${side}${out}\u306B\u9032\u3093\u3067\u304F\u3060\u3055\u3044` : `\u30EA\u30D5\u30C8\u3092\u964D\u308A\u305F\u3089\u3001${out}\u306B\u9032\u3093\u3067\u304F\u3060\u3055\u3044`;
        case "board-lift":
          if (kind === "confirm") return `${out}\u306B\u4E57\u8ECA\u3057\u307E\u3057\u305F`;
          if (kind === "preview") return `\u304A\u3088\u305D${meters}\u30E1\u30FC\u30C8\u30EB\u5148\u3067\u3001${out}\u306B\u4E57\u308A\u307E\u3059`;
          return `\u3053\u306E\u5148\u3001${out}\u306B\u4E57\u3063\u3066\u304F\u3060\u3055\u3044`;
        case "arrive":
          if (kind === "preview") return `\u307E\u3082\u306A\u304F${m.destName}\u306B\u5230\u7740\u3057\u307E\u3059`;
          return `${m.destName}\u306B\u5230\u7740\u3057\u307E\u3057\u305F`;
        default:
          return "";
      }
    }
    const go = m.sameRun ? `\u7EE7\u7EED\u8D70${out}` : `\u8FDB\u5165${out}`;
    const thenZh = m.then ? `\uFF0C\u968F\u540E${then}\u8FDB\u5165${thenOut}` : "";
    switch (m.type) {
      case "fork":
        if (kind === "preview") return `\u7EA6${meters}\u7C73\u540E\u5206\u5C94\uFF0C${side}${go}${thenZh}`;
        if (kind === "late") return side ? `${side}\uFF0C${out}` : `\u8FDB\u5165${out}`;
        if (kind === "confirm") return `\u5DF2\u8FDB\u5165${out}`;
        return side ? `\u524D\u65B9\u5206\u5C94${side}\uFF0C${go}${thenZh}\uFF0C\u524D\u5F80${m.destName}` : `\u524D\u65B9\u5206\u5C94\uFF0C\u8BF7\u6309\u8DEF\u724C${go}${thenZh}\uFF0C\u524D\u5F80${m.destName}`;
      case "exit-lift":
        if (kind === "confirm") return `\u5DF2\u8FDB\u5165${out}`;
        return (side ? `\u4E0B\u7F06\u8F66\u540E${side}\uFF0C\u8FDB\u5165${out}` : `\u4E0B\u7F06\u8F66\u540E\u8FDB\u5165${out}`) + thenZh;
      case "board-lift":
        if (kind === "confirm") return `\u5DF2\u4E58\u4E0A${out}`;
        if (kind === "preview") return `\u7EA6${meters}\u7C73\u540E\u4E58\u5750${out}`;
        return `\u524D\u65B9\u4E58\u5750${out}\uFF0C\u524D\u5F80${m.destName}`;
      case "arrive":
        if (kind === "preview") return `\u5373\u5C06\u5230\u8FBE${m.destName}`;
        return `\u5DF2\u5230\u8FBE${m.destName}`;
      default:
        return "";
    }
  }
  var SYSTEM_TEXT = {
    zh: {
      offRoute: "\u53EF\u80FD\u504F\u79BB\u8DEF\u7EBF\uFF0C\u8BF7\u5728\u5B89\u5168\u4F4D\u7F6E\u505C\u4E0B\u67E5\u770B\u5730\u56FE",
      rerouted: "\u5DF2\u6309\u5F53\u524D\u6240\u5728\u96EA\u9053\u91CD\u65B0\u89C4\u5212\u8DEF\u7EBF",
      noReroute: "\u4ECE\u5F53\u524D\u96EA\u9053\u65E0\u6CD5\u6309\u8BBE\u5B9A\u6761\u4EF6\u5230\u8FBE\u76EE\u7684\u5730\uFF0C\u8BF7\u5728\u5B89\u5168\u4F4D\u7F6E\u505C\u4E0B\u67E5\u770B\u5730\u56FE",
      gpsLost: "\u5B9A\u4F4D\u4FE1\u53F7\u4E2D\u65AD\uFF0C\u6682\u505C\u8F6C\u5F2F\u63D0\u793A",
      gpsWeak: "\u5B9A\u4F4D\u7CBE\u5EA6\u4E0D\u8DB3\uFF0C\u6682\u505C\u8F6C\u5F2F\u63D0\u793A",
      gpsBack: "\u5B9A\u4F4D\u5DF2\u6062\u590D",
      ambiguous: "\u6682\u65F6\u65E0\u6CD5\u786E\u5B9A\u6240\u5728\u96EA\u9053\uFF0C\u8BF7\u7559\u610F\u8DEF\u724C",
      start: (dest) => `\u5F00\u59CB\u5BFC\u822A\uFF0C\u524D\u5F80${dest}`
    },
    ja: {
      offRoute: "\u30EB\u30FC\u30C8\u3092\u5916\u308C\u305F\u53EF\u80FD\u6027\u304C\u3042\u308A\u307E\u3059\u3002\u5B89\u5168\u306A\u5834\u6240\u3067\u6B62\u307E\u3063\u3066\u5730\u56F3\u3092\u78BA\u8A8D\u3057\u3066\u304F\u3060\u3055\u3044",
      rerouted: "\u73FE\u5728\u306E\u30B3\u30FC\u30B9\u304B\u3089\u30EB\u30FC\u30C8\u3092\u518D\u8A08\u7B97\u3057\u307E\u3057\u305F",
      noReroute: "\u73FE\u5728\u306E\u30B3\u30FC\u30B9\u304B\u3089\u6761\u4EF6\u306B\u5408\u3046\u30EB\u30FC\u30C8\u304C\u3042\u308A\u307E\u305B\u3093\u3002\u5B89\u5168\u306A\u5834\u6240\u3067\u6B62\u307E\u3063\u3066\u5730\u56F3\u3092\u78BA\u8A8D\u3057\u3066\u304F\u3060\u3055\u3044",
      gpsLost: "\u4F4D\u7F6E\u60C5\u5831\u304C\u9014\u5207\u308C\u307E\u3057\u305F\u3002\u5206\u5C90\u6848\u5185\u3092\u4E00\u6642\u505C\u6B62\u3057\u307E\u3059",
      gpsWeak: "\u4F4D\u7F6E\u306E\u7CBE\u5EA6\u304C\u4F4E\u3044\u305F\u3081\u3001\u5206\u5C90\u6848\u5185\u3092\u4E00\u6642\u505C\u6B62\u3057\u307E\u3059",
      gpsBack: "\u4F4D\u7F6E\u60C5\u5831\u304C\u56DE\u5FA9\u3057\u307E\u3057\u305F",
      ambiguous: "\u73FE\u5728\u306E\u30B3\u30FC\u30B9\u3092\u7279\u5B9A\u3067\u304D\u307E\u305B\u3093\u3002\u6848\u5185\u677F\u3092\u78BA\u8A8D\u3057\u3066\u304F\u3060\u3055\u3044",
      start: (dest) => `${dest}\u3078\u306E\u6848\u5185\u3092\u958B\u59CB\u3057\u307E\u3059`
    }
  };

  // nav/matcher.js
  var MATCH_CFG = {
    maxDistBase: 30,
    // 候选最大距离下限（m）
    headingWindow: 35,
    // 用最近 35 m 位移计算行进方向（待实测）
    headingMaxAgeMs: 25e3,
    headingTolDeg: 75,
    // 行进方向与雪道方向夹角超过 75° 视为不在这条雪道上行进
    speedWindowMs: 5e3,
    keepMs: 6e4
  };
  var Track = class {
    constructor(cfg = MATCH_CFG) {
      this.cfg = cfg;
      this.fixes = [];
    }
    push(f) {
      this.fixes.push(f);
      const cutoff = f.t - this.cfg.keepMs;
      while (this.fixes.length && this.fixes[0].t < cutoff) this.fixes.shift();
    }
    clear() {
      this.fixes = [];
    }
    last() {
      return this.fixes[this.fixes.length - 1] || null;
    }
    // 行进方向：从最新点往回找，第一个直线距离 ≥ headingWindow 的点
    heading() {
      const f = this.fixes, n = f.length;
      if (n < 2) return null;
      const last = f[n - 1];
      for (let i = n - 2; i >= 0; i--) {
        if (last.t - f[i].t > this.cfg.headingMaxAgeMs) break;
        const d = dist(f[i], last);
        if (d >= this.cfg.headingWindow) return bearing(f[i], last);
      }
      return null;
    }
    // 速度（m/s）：优先用设备给出的速度（多普勒），否则用位移估算
    speed() {
      const f = this.fixes, n = f.length;
      if (!n) return null;
      const recent = f.slice(-3).filter((x) => x.speed != null && x.speed >= 0);
      if (recent.length) return recent.reduce((s, x) => s + x.speed, 0) / recent.length;
      const last = f[n - 1];
      let first = null;
      for (let i = n - 2; i >= 0; i--) {
        if (last.t - f[i].t > this.cfg.speedWindowMs) break;
        first = f[i];
      }
      if (!first || last.t === first.t) return null;
      return dist(first, last) / ((last.t - first.t) / 1e3);
    }
  };
  function prepareIndex(resort) {
    for (const e of resort.edges.values()) {
      if (e.bbox) continue;
      const xs = e.pts.map((p) => p.x), ys = e.pts.map((p) => p.y);
      e.bbox = { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
    }
  }
  function matchFix(resort, fix, { heading, moving, prevEdge }, cfg = MATCH_CFG) {
    prepareIndex(resort);
    const acc = Math.max(3, fix.acc ?? 10);
    const out = [];
    for (const e of resort.edges.values()) {
      const halfW = (e.width_m || (e.type === "lift" ? 10 : 30)) / 2;
      const sigma = Math.hypot(acc, halfW * 0.7);
      const maxD = Math.max(cfg.maxDistBase, 2.5 * sigma);
      const b = e.bbox;
      if (fix.x < b.x0 - maxD || fix.x > b.x1 + maxD || fix.y < b.y0 - maxD || fix.y > b.y1 + maxD) continue;
      const pr = projectToPolyline(fix, e.pts, e.cum);
      if (pr.d > maxD) continue;
      let headingDelta = null, hf = 0.7;
      if (heading != null && moving) {
        headingDelta = Math.abs(angleDiff(heading, pr.heading));
        if (headingDelta > cfg.headingTolDeg) continue;
        hf = 0.4 + 0.6 * Math.cos(headingDelta * Math.PI / 180);
      }
      let cont = 1;
      if (prevEdge) {
        if (e === prevEdge) cont = 1.6;
        else if (prevEdge.to === e.from) cont = 1.3;
      }
      const lik = Math.exp(-0.5 * (pr.d / sigma) ** 2);
      out.push({ edge: e, s: pr.s, d: pr.d, side: pr.side, segHeading: pr.heading, headingDelta, sigma, score: lik * hf * cont });
    }
    out.sort((a, b) => b.score - a.score);
    return out;
  }
  function distanceToEdge(fix, e) {
    return projectToPolyline(fix, e.pts, e.cum);
  }

  // nav/navigator.js
  var NAV_CFG = {
    // 定位可靠性
    accEnter: 25,
    // 误差 > 25 m 连续 2 次 → 定位不可靠
    accExit: 18,
    // 误差 ≤ 18 m 连续 2 次 → 恢复（滞回）
    accCount: 2,
    staleMs: 5e3,
    // 5 秒没有新定位 → 定位中断，不再把旧位置当实时位置
    recoverCount: 2,
    // 恢复需要连续 2 个好定位
    // 静止
    stationarySpeed: 1.2,
    // m/s
    stationaryMs: 3e3,
    // 播报时机：提醒距离 = 速度 ×（语音时长 + 反应时间）+ 定位误差 + 余量
    reactSec: 4,
    marginM: 25,
    minMainM: 40,
    speedFloor: 3,
    // 计算时速度下限 m/s（刚起步也留出余量）
    previewExtraSec: 15,
    // 预告比主提示再提前 15 秒（或至少 150 m）
    previewMinExtraM: 150,
    lateM: 12,
    // 距岔口 < 12 m 还没播报主提示时，只播一句短提示
    // 通过岔口的确认
    passRadius: 20,
    // 距岔口 20 m 内开始“通过待确认”
    confirmAlong: 25,
    // 进入分支至少 25 m 后才可能确认
    confirmCount: 3,
    // 连续 3 次一致才确认
    sepMin: 10,
    // 与其他分支的距离差至少 10 m（或定位误差）
    ambiguityLimit: 200,
    // 过岔口 200 m 还分不清 → 定位不可靠（相邻雪道无法区分）
    // 偏航
    offRatio: 0.35,
    // 路线上的候选得分低于最佳候选的 35%，视为可能不在路线上
    ambiguousRatio: 0.8,
    // 路线候选得分在最佳候选 35%–80% 之间：无法区分，不下结论
    offCount: 3,
    // 连续 3 次 → 偏离路线
    offMapCount: 5,
    // 连续 5 次附近没有任何雪道 → 偏离路线
    offRepeatMs: 6e4,
    // 偏航提示最短间隔
    // 到达
    arriveRadius: 30,
    arrivePreviewM: 150,
    passedHoldMs: 3e3
  };
  var STATE_ZH = {
    idle: "\u672A\u5F00\u59CB",
    navigating: "\u5BFC\u822A\u4E2D",
    approaching: "\u63A5\u8FD1\u5C94\u53E3",
    passing: "\u901A\u8FC7\u5F85\u786E\u8BA4",
    passed: "\u5DF2\u901A\u8FC7",
    offRoute: "\u504F\u79BB\u8DEF\u7EBF",
    unreliable: "\u5B9A\u4F4D\u4E0D\u53EF\u9760",
    arrived: "\u5230\u8FBE",
    paused: "\u5DF2\u6682\u505C"
  };
  var UNRELIABLE_ZH = { stale: "\u5B9A\u4F4D\u4E2D\u65AD", accuracy: "\u7CBE\u5EA6\u4E0D\u8DB3", ambiguous: "\u76F8\u90BB\u96EA\u9053\u65E0\u6CD5\u533A\u5206", waiting: "\u7B49\u5F85\u5B9A\u4F4D" };
  function estimateSpeechSeconds(text, lang = "zh") {
    const n = [...text || ""].length;
    return lang === "ja" ? n / 7 + 0.4 : n / 4.2 + 0.4;
  }
  function announceDistances(speed, acc, tSpeech, cfg = NAV_CFG) {
    const v = Math.max(cfg.speedFloor, speed || 0);
    const main = Math.max(cfg.minMainM, v * (tSpeech + cfg.reactSec) + (acc ?? 10) + cfg.marginM);
    const pre = main + Math.max(cfg.previewMinExtraM, v * cfg.previewExtraSec);
    return { v, tSpeech, main, pre };
  }
  var Navigator = class {
    constructor(resort, opts = {}) {
      this.resort = resort;
      this.cfg = { ...NAV_CFG, ...opts.cfg || {} };
      this.matchCfg = { ...MATCH_CFG, ...opts.matchCfg || {} };
      this.lang = opts.lang || "zh";
      this.estimate = opts.estimateSpeech || ((t) => estimateSpeechSeconds(t, this.lang));
      this.onSpeak = opts.onSpeak || (() => {
      });
      this.onEvent = opts.onEvent || (() => {
      });
      this.reset();
    }
    reset() {
      this.state = "idle";
      this.route = null;
      this.maneuvers = [];
      this.idx = 0;
      this.s = 0;
      this.track = new Track(this.matchCfg);
      this.lastFix = null;
      this.lastFixAt = null;
      this.accBad = 0;
      this.accGood = 0;
      this.unreliable = null;
      this.recoverLeft = 0;
      this.stationarySince = null;
      this.stationary = false;
      this.moving = false;
      this.speed = null;
      this.heading = null;
      this.matched = null;
      this.candidates = [];
      this.offCount = 0;
      this.offMapCount = 0;
      this.ambiguousNow = false;
      this.passing = null;
      this.passedAt = null;
      this.spoken = /* @__PURE__ */ new Map();
      this.log = [];
      this.lastTiming = null;
      this.noLate = /* @__PURE__ */ new Set();
      this.lastOffRouteAt = -Infinity;
      this.rerouteFromEdge = null;
    }
    /* ---------- 控制 ---------- */
    start({ route, destNode, prefs }, now) {
      this.reset();
      this.route = route.edges;
      this.destNode = destNode;
      this.prefs = prefs;
      this.maneuvers = buildManeuvers(this.resort, this.route, destNode);
      this.state = "unreliable";
      this.unreliable = { reason: "waiting" };
      this.recoverLeft = this.cfg.recoverCount;
      this.startedAt = now;
      const last = this.maneuvers[this.maneuvers.length - 1];
      const dest = this.lang === "ja" ? last.destNameJa || last.destName : last.destName;
      this.say("start", SYSTEM_TEXT[this.lang].start(dest), "\u5F00\u59CB\u5BFC\u822A", now);
      this.emit("state", now);
    }
    pause(now) {
      if (this.state === "idle" || this.state === "arrived") return;
      this.pausedFrom = this.state;
      this.state = "paused";
      this.addLog(now, "state", "\u5DF2\u6682\u505C\u5BFC\u822A\uFF08\u6682\u505C\u671F\u95F4\u4E0D\u5224\u65AD\u4F4D\u7F6E\u3001\u4E0D\u64AD\u62A5\uFF09");
    }
    resume(now) {
      if (this.state !== "paused") return;
      this.track.clear();
      this.state = "unreliable";
      this.unreliable = { reason: "waiting" };
      this.recoverLeft = this.cfg.recoverCount;
      this.passing = null;
      this.addLog(now, "state", "\u7EE7\u7EED\u5BFC\u822A\uFF0C\u7B49\u5F85\u65B0\u7684\u5B9A\u4F4D");
    }
    stop(now) {
      this.addLog(now, "state", "\u7ED3\u675F\u5BFC\u822A");
      const log = this.log;
      this.reset();
      this.log = log;
    }
    /* ---------- 输入 ---------- */
    // 定时调用（例如每秒），用于发现“定位中断”
    tick(now) {
      if (!this.isActive()) return;
      if (this.lastFixAt != null && now - this.lastFixAt > this.cfg.staleMs && this.unreliable?.reason !== "stale") {
        this.setUnreliable("stale", now);
        this.track.clear();
      }
    }
    onFix(fix) {
      const now = fix.t;
      if (this.state === "idle" || this.state === "paused" || this.state === "arrived") {
        this.lastFix = fix;
        return;
      }
      this.lastFix = fix;
      this.lastFixAt = now;
      const acc = fix.acc ?? 99;
      if (acc > this.cfg.accEnter) {
        this.accBad++;
        this.accGood = 0;
      } else if (acc <= this.cfg.accExit) {
        this.accGood++;
        this.accBad = 0;
      }
      if (this.accBad >= this.cfg.accCount && this.unreliable?.reason !== "accuracy") {
        this.setUnreliable("accuracy", now);
      }
      if (acc > this.cfg.accEnter) return;
      this.track.push(fix);
      if (this.unreliable && this.unreliable.reason !== "ambiguous") {
        const okAcc = this.unreliable.reason === "accuracy" ? this.cfg.accExit : this.cfg.accEnter;
        if (acc <= okAcc) this.recoverLeft--;
        if (this.recoverLeft > 0) return;
        const was = this.unreliable.reason;
        this.unreliable = null;
        this.state = this.passing ? "passing" : "navigating";
        if (was === "stale" || was === "accuracy") this.say(`back:${now}`, SYSTEM_TEXT[this.lang].gpsBack, "\u5B9A\u4F4D\u6062\u590D", now, { voice: false });
        this.emit("state", now);
      }
      this.speed = this.track.speed();
      this.heading = this.track.heading();
      const movingNow = this.speed != null && this.speed >= this.cfg.stationarySpeed;
      if (movingNow) this.stationarySince = null;
      else if (this.stationarySince == null) this.stationarySince = now;
      this.moving = movingNow;
      this.stationary = !movingNow && this.stationarySince != null && now - this.stationarySince >= this.cfg.stationaryMs;
      const prevEdge = this.matched?.edge || this.route[this.idx];
      this.candidates = matchFix(this.resort, fix, { heading: this.heading, moving: this.moving, prevEdge }, this.matchCfg);
      if (this.state === "offRoute") return this.handleOffRoute(fix, now);
      if (this.passing) return this.handlePassing(fix, now);
      return this.handleOnRoute(fix, now);
    }
    /* ---------- 路线上 ---------- */
    handleOnRoute(fix, now) {
      const cfg = this.cfg;
      const cur = this.route[this.idx], nxt = this.route[this.idx + 1];
      const top = this.candidates[0];
      const onRoute = this.candidates.filter((c) => c.edge === cur || c.edge === nxt);
      const eBest = onRoute[0] || null;
      if (!top) {
        this.offMapCount++;
        this.matched = null;
        if (this.offMapCount >= cfg.offMapCount) return this.enterOffRoute(null, now, "\u9644\u8FD1\u6CA1\u6709\u5DF2\u77E5\u96EA\u9053");
        return;
      }
      this.offMapCount = 0;
      if (!eBest || eBest.score < cfg.offRatio * top.score) {
        this.offCount++;
        this.ambiguousNow = false;
        if (this.offCount >= cfg.offCount) return this.enterOffRoute(top, now, `\u8FDE\u7EED ${this.offCount} \u6B21\u5339\u914D\u5230\u8DEF\u7EBF\u5916\u7684 ${edgeLabel(top.edge)}`);
        return;
      }
      this.offCount = 0;
      this.ambiguousNow = eBest !== top && eBest.score < cfg.ambiguousRatio * top.score;
      this.matched = eBest;
      if (eBest.edge === nxt) this.s = cur.length;
      else this.s = eBest.s;
      if (this.state === "passed" && now - this.passedAt > cfg.passedHoldMs) this.state = "navigating";
      const { m, d } = this.nextAnnounced();
      if (m) this.handleAnnouncements(m, d, fix, now);
      const mHere = this.maneuvers[this.idx];
      const remaining = cur.length - this.s;
      if (mHere.type === "arrive") {
        if (remaining <= cfg.arriveRadius) return this.arrive(now);
        return;
      }
      if (remaining <= cfg.passRadius || eBest.edge === nxt) {
        if (mHere.type === "continue") {
          if (eBest.edge === nxt) {
            this.idx++;
            this.s = eBest.s;
          }
        } else {
          this.passing = { m: mHere, correct: 0, wrong: 0, startAt: now, maxAlong: 0 };
          this.state = "passing";
          this.emit("state", now);
        }
      }
    }
    // 沿路线找到下一个需要播报的指令，以及沿路线的距离
    nextAnnounced() {
      let d = this.route[this.idx].length - this.s;
      for (let j = this.idx; j < this.maneuvers.length; j++) {
        const m = this.maneuvers[j];
        if (j > this.idx) d += this.route[j].length;
        if (m.announce) return { m, d: Math.max(0, d) };
      }
      return { m: null, d: null };
    }
    handleAnnouncements(m, d, fix, now) {
      const cfg = this.cfg;
      const mainText = maneuverText(m, "main", { lang: this.lang });
      const tSpeech = this.estimate(mainText);
      const t = announceDistances(this.speed, fix.acc, tSpeech, cfg);
      this.lastTiming = { ...t, d, maneuver: m.id };
      const hold = this.stationary || this.ambiguousNow;
      if (this.noLate.has(m.id)) {
        if (!this.spoken.has(`quiet:${m.id}`)) {
          this.spoken.set(`quiet:${m.id}`, now);
          this.addLog(now, "text", `\uFF08\u4EC5\u6587\u5B57\uFF09${mainText} \u2014 \u91CD\u65B0\u89C4\u5212\u540E\u8DDD\u5C94\u53E3\u4EC5 ${Math.round(d)} m\uFF0C\u4E0D\u505A\u8BED\u97F3\u50AC\u4FC3`);
        }
        return;
      }
      if (m.type !== "arrive" && this.state !== "passing" && this.state !== "passed") {
        this.state = d <= t.pre ? "approaching" : "navigating";
      }
      if (hold) return;
      if (m.type === "arrive") {
        if (d <= cfg.arrivePreviewM && d > cfg.arriveRadius) this.say(`pre:${m.id}`, maneuverText(m, "preview", { lang: this.lang }), `\u8DDD\u76EE\u7684\u5730 ${Math.round(d)} m`, now);
        return;
      }
      const reason = `\u6CBF\u8DEF\u8DDD\u79BB ${Math.round(d)} m\uFF0C\u901F\u5EA6 ${(t.v * 3.6).toFixed(0)} km/h\uFF0C\u8BEF\u5DEE \xB1${Math.round(fix.acc ?? 0)} m\uFF0C\u8BED\u97F3\u7EA6 ${t.tSpeech.toFixed(1)} s \u2192 \u4E3B\u63D0\u793A\u9608\u503C ${Math.round(t.main)} m`;
      if (d <= t.pre && d > t.main + 50) {
        this.say(`pre:${m.id}`, maneuverText(m, "preview", { lang: this.lang, distance: d }), "\u9884\u544A\uFF1A" + reason, now);
      }
      const atStart = this.idx === 0 && this.s < 30;
      let spokeMain = false;
      if (d <= t.main && (d > cfg.lateM || atStart)) {
        spokeMain = this.say(`main:${m.id}`, mainText, (atStart && d <= cfg.lateM ? "\u5BFC\u822A\u5F00\u59CB\u65F6\u5DF2\u5728\u5C94\u53E3\u9644\u8FD1\uFF1A" : "\u4E3B\u63D0\u793A\uFF1A") + reason, now);
      } else if (d <= cfg.lateM && !this.spoken.has(`main:${m.id}`)) {
        spokeMain = this.say(`main:${m.id}`, maneuverText(m, "late", { lang: this.lang }), "\u6765\u4E0D\u53CA\u5B8C\u6574\u64AD\u62A5\uFF0C\u77ED\u63D0\u793A\uFF1A" + reason, now);
      }
      if (spokeMain && m.then) {
        for (const key of ["pre", "main"]) if (!this.spoken.has(`${key}:${m.then.id}`)) this.spoken.set(`${key}:${m.then.id}`, now);
      }
    }
    /* ---------- 通过岔口 ---------- */
    handlePassing(fix, now) {
      const cfg = this.cfg;
      const P = this.passing, m = P.m;
      const outs = [m.outEdge, ...m.alternatives];
      const cOut = this.candidates.filter((c) => outs.includes(c.edge));
      const best = cOut[0] || null;
      const acc = fix.acc ?? 10;
      const sepNeeded = Math.max(cfg.sepMin, acc);
      const dExp = distanceToEdge(fix, m.outEdge).d;
      const dAlts = m.alternatives.map((e) => distanceToEdge(fix, e).d);
      const dAltMin = dAlts.length ? Math.min(...dAlts) : Infinity;
      this.matched = best || this.candidates.find((c) => c.edge === m.inEdge) || null;
      if (best) P.maxAlong = Math.max(P.maxAlong, best.s);
      const confirmAlong = Math.min(cfg.confirmAlong, m.outEdge.length * 0.6);
      const routeAhead = this.route.slice(this.idx + 2);
      const top = this.candidates[0] || null;
      const ahead = top && routeAhead.includes(top.edge) ? top : null;
      let verdict = "unknown";
      P.ahead = null;
      if (!this.stationary) {
        if (best && best.s >= confirmAlong) {
          if (best.edge === m.outEdge && dAltMin - dExp >= sepNeeded) verdict = "correct";
          else if (best.edge !== m.outEdge && dExp - best.d >= sepNeeded) {
            verdict = "wrong";
            P.wrongCand = best;
          }
        }
        if (verdict === "unknown" && ahead && dAltMin - ahead.d >= sepNeeded) {
          verdict = "correct";
          P.ahead = ahead;
        }
        if (verdict === "unknown" && top && !outs.includes(top.edge) && top.edge !== m.inEdge && !routeAhead.includes(top.edge)) {
          if (dExp - top.d >= sepNeeded) {
            verdict = "wrong";
            P.wrongCand = top;
          }
        }
      }
      if (verdict === "correct") {
        P.correct++;
        P.wrong = 0;
      } else if (verdict === "wrong") {
        P.wrong++;
        P.correct = 0;
      } else {
        P.correct = 0;
        P.wrong = 0;
      }
      P.last = { verdict, dExp, dAltMin, sepNeeded, along: best?.s ?? 0 };
      if (P.correct >= cfg.confirmCount) {
        this.passing = null;
        if (P.ahead) {
          const j = this.route.indexOf(P.ahead.edge);
          for (let k = this.idx + 1; k < j; k++) {
            const mk = this.maneuvers[k];
            for (const key of ["pre", "main", "confirm"]) if (!this.spoken.has(`${key}:${mk.id}`)) this.spoken.set(`${key}:${mk.id}`, now);
          }
          this.idx = j;
          this.s = P.ahead.s;
          this.matched = P.ahead;
        } else {
          this.idx++;
          this.s = distanceToEdge(fix, m.outEdge).s;
          this.matched = { edge: m.outEdge, s: this.s };
        }
        this.unreliable = null;
        this.state = "passed";
        this.passedAt = now;
        const kind = m.type === "board-lift" ? "\u4E58\u4E0A\u7F06\u8F66" : "\u8FDB\u5165\u5206\u652F";
        this.say(`confirm:${m.id}`, maneuverText(m, "confirm", { lang: this.lang }), `\u8FDE\u7EED ${cfg.confirmCount} \u6B21\u786E\u8BA4${kind}${P.ahead ? "\uFF08\u5DF2\u5230\u540E\u7EED\u8DEF\u6BB5\uFF09" : ""}\uFF1A\u8DDD\u9884\u671F\u5206\u652F ${Math.round(P.ahead ? P.ahead.d : dExp)} m\uFF0C\u8DDD\u5176\u4ED6\u5206\u652F \u2265 ${Math.round(dAltMin)} m`, now, { voice: !m.sameRun });
        this.emit("state", now);
        return;
      }
      if (P.wrong >= cfg.confirmCount) {
        this.passing = null;
        const wc = P.wrongCand;
        return this.enterOffRoute(wc, now, `\u5728${m.nodeId}\u8FDB\u5165\u4E86 ${edgeLabel(wc.edge)}\uFF08\u8FDE\u7EED ${cfg.confirmCount} \u6B21\uFF09`);
      }
      if (P.maxAlong > cfg.ambiguityLimit && verdict === "unknown") {
        if (this.unreliable?.reason !== "ambiguous") {
          this.unreliable = { reason: "ambiguous" };
          this.state = "unreliable";
          this.say(`amb:${m.id}`, SYSTEM_TEXT[this.lang].ambiguous, `\u8FC7\u5C94\u53E3 ${Math.round(P.maxAlong)} m \u4ECD\u65E0\u6CD5\u533A\u5206\u5206\u652F\uFF08\u9884\u671F ${Math.round(dExp)} m / \u5176\u4ED6 ${Math.round(dAltMin)} m\uFF09`, now);
          this.emit("state", now);
        }
      } else if (this.unreliable?.reason !== "ambiguous") {
        this.state = "passing";
      }
    }
    /* ---------- 偏航 ---------- */
    enterOffRoute(cand, now, why) {
      this.passing = null;
      this.state = "offRoute";
      this.offCount = 0;
      this.matched = cand;
      if (now - this.lastOffRouteAt >= this.cfg.offRepeatMs) {
        this.lastOffRouteAt = now;
        this.say(`off:${now}`, SYSTEM_TEXT[this.lang].offRoute, "\u504F\u79BB\u8DEF\u7EBF\uFF1A" + why, now);
      } else {
        this.addLog(now, "info", "\u518D\u6B21\u504F\u79BB\u8DEF\u7EBF\uFF0860 \u79D2\u5185\u4E0D\u91CD\u590D\u64AD\u62A5\uFF09\uFF1A" + why);
      }
      this.emit("state", now);
      this.tryReroute(cand, now);
    }
    handleOffRoute(fix, now) {
      const top = this.candidates[0];
      if (!top) {
        this.matched = null;
        return;
      }
      this.matched = top;
      this.tryReroute(top, now);
    }
    // 只从“当前所在雪道向前”重新规划：不会要求掉头或逆行
    tryReroute(cand, now) {
      if (!cand) return;
      if (this.rerouteFromEdge === cand.edge.id) return;
      this.rerouteFromEdge = cand.edge.id;
      const plan = planRoute(this.resort, { startEdgeId: cand.edge.id, goalNode: this.destNode }, this.prefs);
      if (!plan.ok) {
        this.say(`noreroute:${cand.edge.id}`, SYSTEM_TEXT[this.lang].noReroute, `\u4ECE ${edgeLabel(cand.edge)} \u51FA\u53D1\uFF1A${plan.reason}`, now);
        return;
      }
      this.route = plan.edges;
      this.maneuvers = buildManeuvers(this.resort, this.route, this.destNode);
      this.idx = 0;
      this.s = cand.s;
      this.passing = null;
      this.state = "navigating";
      this.rerouteFromEdge = null;
      const { m, d } = this.nextAnnounced();
      if (m && d < this.cfg.minMainM) this.noLate.add(m.id);
      this.say(`reroute:${now}`, SYSTEM_TEXT[this.lang].rerouted, `\u4ECE ${edgeLabel(cand.edge)} \u5411\u524D\u91CD\u65B0\u89C4\u5212\uFF0C\u5171 ${this.route.length} \u6BB5`, now);
      this.emit("state", now);
    }
    arrive(now) {
      const m = this.maneuvers[this.maneuvers.length - 1];
      this.state = "arrived";
      this.say(`arrive:${m.id}`, maneuverText(m, "main", { lang: this.lang }), "\u5DF2\u5230\u8FBE\u76EE\u7684\u5730\u9644\u8FD1", now);
      this.emit("state", now);
    }
    /* ---------- 工具 ---------- */
    isActive() {
      return !["idle", "paused", "arrived"].includes(this.state);
    }
    setUnreliable(reason, now) {
      this.unreliable = { reason };
      this.state = "unreliable";
      this.recoverLeft = this.cfg.recoverCount;
      this.ambiguousNow = false;
      if (reason === "stale") this.say(`lost:${now}`, SYSTEM_TEXT[this.lang].gpsLost, `\u8D85\u8FC7 ${this.cfg.staleMs / 1e3} \u79D2\u6CA1\u6709\u65B0\u5B9A\u4F4D`, now, { cooldownKey: "gps", cooldownMs: 3e4 });
      if (reason === "accuracy") this.say(`weak:${now}`, SYSTEM_TEXT[this.lang].gpsWeak, `\u5B9A\u4F4D\u8BEF\u5DEE > ${this.cfg.accEnter} m`, now, { cooldownKey: "gps", cooldownMs: 3e4 });
      this.emit("state", now);
    }
    // 播报（带去重）：同一个 key 只说一次；cooldownKey 用于限制同类提示的频率
    say(key, text, reason, now, { voice = true, cooldownKey = null, cooldownMs = 0 } = {}) {
      if (this.spoken.has(key)) return false;
      if (cooldownKey) {
        const lastAt = this.spoken.get("cd:" + cooldownKey);
        if (lastAt != null && now - lastAt < cooldownMs) {
          this.addLog(now, "suppressed", `${text}\uFF08${Math.round(cooldownMs / 1e3)} \u79D2\u5185\u4E0D\u91CD\u590D\uFF09`);
          return false;
        }
        this.spoken.set("cd:" + cooldownKey, now);
      }
      this.spoken.set(key, now);
      const item = { t: now, key, text, reason, voice, state: this.state };
      this.log.push({ ...item, type: voice ? "speak" : "text" });
      this.onSpeak(item);
      return true;
    }
    addLog(now, type, text) {
      this.log.push({ t: now, type, text });
    }
    emit(type, now) {
      this.onEvent({ type, state: this.state, t: now });
    }
    // 给界面用的当前状态
    snapshot(now) {
      const fix = this.lastFix;
      const ageMs = this.lastFixAt != null && now != null ? now - this.lastFixAt : null;
      const stale = this.isActive() && ageMs != null && ageMs > this.cfg.staleMs;
      let next = null, dist2 = null, remaining = null;
      if (this.route && this.state !== "arrived") {
        const r = this.nextAnnounced();
        next = r.m;
        dist2 = r.d;
        remaining = this.route.slice(this.idx).reduce((a, e) => a + e.length, 0) - this.s;
      }
      const trustworthy = !this.unreliable && !stale && this.state !== "offRoute";
      return {
        state: this.state,
        stateZh: STATE_ZH[this.state],
        unreliable: this.unreliable ? UNRELIABLE_ZH[this.unreliable.reason] : null,
        stationary: this.stationary,
        ambiguous: this.ambiguousNow,
        fix,
        ageMs,
        stale,
        acc: fix?.acc ?? null,
        speed: this.speed,
        heading: this.heading,
        route: this.route,
        idx: this.idx,
        s: this.s,
        matched: this.matched,
        candidates: this.candidates.slice(0, 4),
        next,
        nextText: next ? maneuverText(next, "main", { lang: this.lang }) : null,
        distToNext: trustworthy ? dist2 : null,
        remaining: trustworthy ? remaining : null,
        passing: this.passing,
        timing: this.lastTiming,
        log: this.log
      };
    }
  };

  // nav/simulator.js
  var SIM_SPEED = { 1: 6, 2: 9, 3: 11, 4: 12 };
  var FLAT_SPEED = 3;
  var WALK_SPEED = 1.3;
  var LIFT_SPEED = 4;
  var Simulator = class {
    constructor(resort, { seed = 7, drift = 4, carve = true, skierFactor = 1 } = {}) {
      this.resort = resort;
      this.rand = seededRandom(seed);
      this.drift = drift;
      this.carve = carve;
      this.skierFactor = skierFactor;
      this.outageUntil = -Infinity;
      this.wrongAtNextFork = false;
      this.path = [];
      this.reset();
    }
    // 设置真实路径（通常就是规划的路线）
    setPath(edges, { plannedRoute = null } = {}) {
      this.path = edges.slice();
      this.plannedRoute = plannedRoute || edges.slice();
      this.reset();
    }
    reset() {
      this.k = 0;
      this.s = 0;
      this.t = 0;
      this.dx = 0;
      this.dy = 0;
      this.done = false;
      this.travelled = 0;
      this.wrongTaken = null;
    }
    edgeSpeed(e) {
      if (e.type === "lift") return e.duration_min ? e.length / (e.duration_min * 60) : LIFT_SPEED;
      if (e.type === "connector") return WALK_SPEED;
      if (e.flat === true) return FLAT_SPEED * this.skierFactor;
      return (SIM_SPEED[e.difficulty] || 8) * this.skierFactor;
    }
    // 在下一个岔口走错：把 path 从该岔口起替换为另一条分支 + 之后一路往下
    takeWrongBranchAtNextFork() {
      for (let k = this.k; k < this.path.length - 1; k++) {
        const e = this.path[k], next = this.path[k + 1];
        if (k === this.k && this.s > e.length - 30) continue;
        const alts = (this.resort.out.get(e.to) || []).filter((x) => x !== next && x.type !== "lift");
        if (!alts.length) continue;
        const alt = alts.find((x) => x.open !== false) || alts[0];
        this.path = [...this.path.slice(0, k + 1), alt];
        this.wrongTaken = { atNode: e.to, edge: alt.id };
        return this.wrongTaken;
      }
      return null;
    }
    // 路径走完但还没到目的地时（走错分支之后），决定下一段
    extendPath(nodeId) {
      if (!this.wrongTaken) return;
      let next = this.follow ? this.follow(nodeId) : null;
      if (!next) next = (this.resort.out.get(nodeId) || []).find((x) => x.type !== "lift") || null;
      if (next && this.path.length < 200) this.path.push(next);
    }
    startOutage(seconds) {
      this.outageUntil = this.t + seconds * 1e3;
    }
    get inOutage() {
      return this.t < this.outageUntil;
    }
    // 前进 dtSec 秒，返回这一步产生的定位点（中断时返回 null）
    step(dtSec = 1) {
      this.t += dtSec * 1e3;
      let truth;
      if (!this.done) {
        let left = dtSec;
        while (left > 0 && !this.done) {
          const e2 = this.path[this.k];
          const v2 = this.edgeSpeed(e2);
          const need = (e2.length - this.s) / v2;
          if (need > left) {
            this.s += v2 * left;
            this.travelled += v2 * left;
            left = 0;
          } else {
            this.travelled += e2.length - this.s;
            left -= need;
            if (this.k === this.path.length - 1) this.extendPath(e2.to);
            if (this.k < this.path.length - 1) {
              this.k++;
              this.s = 0;
            } else {
              this.s = e2.length;
              this.done = true;
            }
          }
        }
      }
      const e = this.path[this.k];
      const p = pointAt(e.pts, e.cum, this.s);
      truth = { x: p.x, y: p.y, edge: e.id, s: this.s };
      this.lastTruth = truth;
      let lx = 0, ly = 0;
      if (this.carve && !this.done && e.type === "run" && e.flat !== true) {
        const amp = Math.min(8, (e.width_m || 30) * 0.3);
        const off = amp * Math.sin(2 * Math.PI * this.travelled / 45);
        const h = p.heading * Math.PI / 180;
        lx = Math.cos(h) * off;
        ly = -Math.sin(h) * off;
      }
      const a = 0.85;
      this.dx = a * this.dx + Math.sqrt(1 - a * a) * this.drift * gaussian(this.rand);
      this.dy = a * this.dy + Math.sqrt(1 - a * a) * this.drift * gaussian(this.rand);
      if (this.inOutage) return null;
      const v = this.done ? 0 : this.edgeSpeed(e);
      return {
        t: this.t,
        x: p.x + lx + this.dx,
        y: p.y + ly + this.dy,
        acc: Math.round(this.drift * 1.6 + 4),
        speed: Math.max(0, v + gaussian(this.rand) * 0.3),
        source: "sim",
        truth
      };
    }
  };

  // nav/nlp.js
  var DIFF_WORDS = [
    // [正则, 难度上限, 说明]
    [/(只|仅)(走|滑)?(初级|绿道|新手|入门|简单)/, 1, "\u53EA\u8D70\u521D\u7EA7\u9053"],
    [/(新手|初学|刚学|第一次滑)/, 1, "\u521D\u5B66\u8005 \u2192 \u53EA\u8D70\u521D\u7EA7\u9053"],
    [/(不|别|不要|避开|不想)(走|滑|去)?(中级|红道)/, 1, "\u4E0D\u8D70\u4E2D\u7EA7\u9053"],
    [/(不|别|不要|避开|不想)(走|滑|去)?(高级|黑道|上级|难的|陡的|陡坡)/, 2, "\u4E0D\u8D70\u9AD8\u7EA7\u9053"],
    [/(不|别|不要|避开|不想)(走|滑|去)?(专家|超高级|野雪|树林)/, 3, "\u4E0D\u8D70\u4E13\u5BB6\u7EA7\u9053"],
    [/(只|仅)(走|滑)?(中级|红道)/, 2, "\u6700\u9AD8\u4E2D\u7EA7\u9053"],
    [/(可以|能|想|要)(走|滑)?(高级|黑道|上级)/, 3, "\u5141\u8BB8\u9AD8\u7EA7\u9053"],
    [/(什么都行|都可以|随便|不限难度|专家级也行)/, 4, "\u4E0D\u9650\u96BE\u5EA6"]
  ];
  var FLAT_WORDS = /(蹬|推着走|推着|走路|走着|平路|平地|平的|撑杖|划着走|单板.*平|不想.*走)/;
  var SHORT_WORDS = /(最短|最近|近一点|快点|尽快|抄近路|直接|赶时间)/;
  var FAST_WORDS = /(最快|省时间)/;
  function normalize(s) {
    return (s || "").replace(/\s+/g, "").replace(/[，,。.！!？?、；;]/g, "\uFF0C");
  }
  function findPlaces(text, resort) {
    const hits = [];
    for (const p of resort.pois) {
      for (const name of [p.name, ...p.aliases || []]) {
        if (!name) continue;
        let i = text.indexOf(name);
        while (i >= 0) {
          hits.push({ poi: p, name, at: i, len: name.length });
          i = text.indexOf(name, i + 1);
        }
      }
    }
    hits.sort((a, b) => a.at - b.at || b.len - a.len);
    const out = [];
    for (const h of hits) {
      if (out.some((o) => h.at >= o.at && h.at + h.len <= o.at + o.len && !(o.at === h.at && o.len === h.len))) continue;
      out.push(h);
    }
    return out;
  }
  function parseRequest(input, resort) {
    const text = normalize(input);
    const result = {
      input,
      start: null,
      destination: null,
      maxDifficulty: null,
      avoidFlat: null,
      preferShort: null,
      understood: [],
      notUnderstood: [],
      ambiguous: [],
      ok: false
    };
    if (!text) {
      result.notUnderstood.push("\uFF08\u7A7A\uFF09");
      return result;
    }
    const places = findPlaces(text, resort);
    const used = [];
    const groups = /* @__PURE__ */ new Map();
    for (const h of places) {
      const k = h.at + ":" + h.len;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(h);
    }
    for (const hs of groups.values()) {
      const h = hs[0];
      const before = text.slice(Math.max(0, h.at - 3), h.at);
      const role = /(从|在|由)$/.test(before) || /^(出发|开始)/.test(text.slice(h.at + h.len, h.at + h.len + 2)) ? "start" : "destination";
      const uniq = [...new Set(hs.map((x) => x.poi))];
      used.push([h.at, h.at + h.len]);
      if (uniq.length > 1) {
        result.ambiguous.push(`\u201C${h.name}\u201D\u53EF\u80FD\u6307\uFF1A${uniq.map((p) => p.name).join(" / ")}\uFF0C\u8BF7\u5728\u4E0B\u9762\u9009\u62E9`);
        continue;
      }
      if (role === "start") {
        result.start = uniq[0];
        result.understood.push(`\u8D77\u70B9\uFF1A${uniq[0].name}`);
      } else if (!result.destination) {
        result.destination = uniq[0];
        result.understood.push(`\u76EE\u7684\u5730\uFF1A${uniq[0].name}`);
      } else result.ambiguous.push(`\u63D0\u5230\u4E86\u591A\u4E2A\u76EE\u7684\u5730\uFF08${result.destination.name}\u3001${uniq[0].name}\uFF09\uFF0C\u5148\u7528\u7B2C\u4E00\u4E2A`);
    }
    for (const [re, level, label] of DIFF_WORDS) {
      const m = re.exec(text);
      if (!m) continue;
      used.push([m.index, m.index + m[0].length]);
      if (result.maxDifficulty == null || level < result.maxDifficulty) result.maxDifficulty = level;
      result.understood.push(label);
    }
    const flat = FLAT_WORDS.exec(text);
    if (flat) {
      result.avoidFlat = true;
      used.push([flat.index, flat.index + flat[0].length]);
      result.understood.push("\u5C3D\u91CF\u907F\u5F00\u5E73\u8DEF");
    }
    const short = SHORT_WORDS.exec(text) || FAST_WORDS.exec(text);
    if (short) {
      result.preferShort = true;
      used.push([short.index, short.index + short[0].length]);
      result.understood.push("\u4F18\u5148\u77ED\u8DEF\u7EBF");
    }
    const FILLER = /^(我|我要|我想|想|要|请|帮我|麻烦|一下|吧|呢|啊|哦|嗯|去|到|回|前往|从|出发|然后|再|和|并且|而且|但是|不过|尽量|最好|让我|给我|的|了|走|滑|路线|一条|条)+$/;
    for (const part of text.split("\uFF0C")) {
      if (!part) continue;
      const start = text.indexOf(part);
      const covered = used.some(([a, b]) => a < start + part.length && b > start);
      if (!covered && !FILLER.test(part)) result.notUnderstood.push(part);
    }
    result.ok = result.understood.length > 0;
    return result;
  }

  // nav/scenario.js
  function runScenario(r, { start, goal, prefs, sim = {}, events = [], maxSec = 3e3, navCfg, routeEdges, lang } = {}) {
    const plan = routeEdges ? { ok: true, edges: routeEdges.map((id) => r.edges.get(id)) } : planRoute(r, { startNode: start, goalNode: goal }, prefs);
    if (!plan.ok) throw new Error("\u65E0\u6CD5\u89C4\u5212\uFF1A" + plan.reason);
    const spoken = [];
    const states = [];
    const nav = new Navigator(r, { onSpeak: (x) => spoken.push(x), cfg: navCfg, lang });
    const simu = new Simulator(r, { seed: sim.seed ?? 3, drift: sim.drift ?? 4, carve: sim.carve ?? true });
    simu.setPath(plan.edges);
    simu.follow = (node) => (nav.route || []).slice(nav.idx).find((e) => e.from === node) || null;
    nav.start({ route: plan, destNode: goal, prefs }, 0);
    const snaps = [];
    let lastState = null, doneAt = null;
    for (let sec = 1; sec <= maxSec; sec++) {
      if (nav.state === "arrived" || doneAt != null && sec - doneAt > 30) {
        for (let k = 0; k < 10; k++) {
          const f = simu.step(1);
          if (f) nav.onFix(f);
          nav.tick(simu.t);
        }
        break;
      }
      if (simu.done && doneAt == null) doneAt = sec;
      for (const ev of events) if (ev.at === sec) ev.do({ nav, simu, sec });
      const fix = simu.step(1);
      if (fix) nav.onFix(fix);
      nav.tick(simu.t);
      const snap = nav.snapshot(simu.t);
      snaps.push({ sec, snap, truth: fix?.truth, fix, inOutage: simu.inOutage });
      if (snap.state !== lastState) {
        states.push({ sec, state: snap.state, reason: snap.unreliable });
        lastState = snap.state;
      }
    }
    return { plan, spoken, states, snaps, nav, simu, log: nav.log };
  }

  // nav/companion.js
  var INTENTS = ["navigate", "confirm", "cancel", "stop", "pause", "resume", "distance", "repeat", "easier", "where", "chat", "unknown"];
  var INTENT_SCHEMA = {
    type: "object",
    additionalProperties: false,
    required: ["intent", "destination", "start", "maxDifficulty", "avoidFlat", "preferShort", "reply"],
    properties: {
      intent: { type: "string", enum: INTENTS },
      destination: { type: "string" },
      start: { type: "string" },
      maxDifficulty: { type: "integer", enum: [0, 1, 2, 3, 4] },
      avoidFlat: { type: "string", enum: ["yes", "no", ""] },
      preferShort: { type: "string", enum: ["yes", "no", ""] },
      reply: { type: "string" }
    }
  };
  var WAKE_WORDS = ["\u96EA\u4EBA", "\u96EA\u3060\u308B\u307E", "\u3086\u304D\u3060\u308B\u307E"];
  var WAKE_RE = /(嘿|喂|哎)?\s*(雪人|雪仁|血人|学人|薛人|穴人|雪だるま|ゆきだるま)[，,。.！!？?、\s]*/g;
  var EMPTY = { intent: "unknown", destination: "", start: "", maxDifficulty: 0, avoidFlat: "", preferShort: "", reply: "" };
  function hasWake(text) {
    WAKE_RE.lastIndex = 0;
    return WAKE_RE.test(text || "");
  }
  function afterWake(text) {
    const t = text || "";
    WAKE_RE.lastIndex = 0;
    let m, end = -1;
    while (m = WAKE_RE.exec(t)) end = m.index + m[0].length;
    return end < 0 ? t : t.slice(end).replace(/^[\s，,。.、！!？?]+/, "");
  }
  function stripWake(text) {
    const t = (text || "").trim();
    WAKE_RE.lastIndex = 0;
    const parts = t.split(WAKE_RE).filter((x, i) => i % 3 === 0);
    const clean = (x) => x.replace(/^[\s，,。.、！!？?呀啊]+|[\s，,。.、]+$/g, "").trim();
    const pieces = parts.map(clean).filter(Boolean);
    if (!pieces.length) return "";
    const after = clean(parts[parts.length - 1]);
    return after || pieces.join("\uFF0C");
  }
  var RULES = [
    // 顺序有意义：先匹配更具体的
    ["stop", /(结束导航|停止导航|不导航了|关掉导航|退出导航|案内(を)?終了|ナビ(を)?終了)/],
    ["pause", /(暂停|先停一下|等一下|一時停止)/],
    ["resume", /(继续导航|恢复导航|继续吧|^继续|再開)/],
    ["repeat", /(再说一遍|再说一次|重复|没听清|刚才说什么|もう一度|もう一回)/],
    ["distance", /(多远|还有多少|还要多久|多长时间|还有几|距离|あとどれ|どのくらい|何メートル)/],
    ["easier", /(简单点|简单一点|轻松|容易点|容易一点|累了|好累|太难|太陡|簡単|楽な)/],
    ["where", /(我在哪|在哪里|这是哪|现在在哪|ここはどこ|今どこ)/],
    ["cancel", /^(不要|不用|取消|算了|不了|不去了|别去了|いいえ|やめ|キャンセル)/],
    ["confirm", /^(好|好的|好啊|开始|出发|走吧|走|可以|行|对|是的|嗯|没问题|ok|okay|go|はい|お願い|スタート|行こう)/i]
  ];
  function rulesIntent(text, resort) {
    const t = stripWake(text);
    if (!t) return { ...EMPTY, intent: "unknown" };
    const req = parseRequest(t, resort);
    const hasPlace = !!(req.destination || req.ambiguous.length);
    for (const [intent, re] of RULES) {
      if (!re.test(t)) continue;
      if ((intent === "confirm" || intent === "cancel") && hasPlace) break;
      if (intent === "easier") return { ...EMPTY, intent, maxDifficulty: 0 };
      return { ...EMPTY, intent };
    }
    if (hasPlace || req.maxDifficulty != null || req.avoidFlat || req.preferShort) {
      const amb = req.ambiguous.length && !req.destination ? (req.ambiguous[0].match(/“(.+?)”/) || [])[1] || "" : "";
      return {
        ...EMPTY,
        intent: "navigate",
        destination: req.destination?.name || amb,
        start: req.start?.name || "",
        maxDifficulty: req.maxDifficulty ?? 0,
        avoidFlat: req.avoidFlat ? "yes" : "",
        preferShort: req.preferShort ? "yes" : ""
      };
    }
    return { ...EMPTY, intent: "unknown" };
  }
  function resolvePlace(resort, text) {
    const q = (text || "").replace(/\s+/g, "");
    if (!q) return null;
    const cands = [];
    const add = (node, name, score) => {
      const old = cands.find((c) => c.node === node);
      if (!old) cands.push({ node, name, score });
      else if (score > old.score) old.score = score;
    };
    for (const p of resort.pois) {
      const names = [p.name, p.name_ja, ...p.aliases || []].filter(Boolean);
      for (const n of names) {
        if (n === q) add(p.node, p.name, 3);
        else if (q.includes(n) && n.length >= 2) add(p.node, p.name, 2);
        else if (n.includes(q) && q.length >= 2) add(p.node, p.name, 1);
      }
    }
    for (const n of resort.nodes.values()) {
      if (!n.name || resort.pois.some((p) => p.node === n.id)) continue;
      if (n.name === q) add(n.id, n.name, 3);
      else if (q.length >= 2 && (n.name.includes(q) || q.includes(n.name))) add(n.id, n.name, 1);
    }
    if (!cands.length) return null;
    const best = Math.max(...cands.map((c) => c.score));
    const top = cands.filter((c) => c.score === best);
    if (top.length === 1) return top[0];
    return { ambiguous: top.map((c) => c.name) };
  }
  var DIFF_ZH = { 1: "\u521D\u7EA7", 2: "\u4E2D\u7EA7", 3: "\u9AD8\u7EA7", 4: "\u4E13\u5BB6\u7EA7" };
  var DIFF_JA = { 1: "\u521D\u7D1A", 2: "\u4E2D\u7D1A", 3: "\u4E0A\u7D1A", 4: "\u30A8\u30AD\u30B9\u30D1\u30FC\u30C8" };
  var T = {
    zh: {
      noDest: (ex) => `\u8981\u53BB\u54EA\u91CC\uFF1F\u6BD4\u5982\uFF1A${ex}`,
      notFound: (q, ex) => `\u5730\u56FE\u4E0A\u6CA1\u6709\u627E\u5230\u201C${q}\u201D\u3002\u53EF\u4EE5\u53BB\uFF1A${ex}`,
      ambiguous: (list) => `\u4F60\u8BF4\u7684\u662F${list.join("\uFF0C\u8FD8\u662F")}\uFF1F`,
      noStart: "\u6211\u8FD8\u4E0D\u77E5\u9053\u4F60\u73B0\u5728\u5728\u54EA\u3002\u8BF7\u8BF4\u4ECE\u54EA\u91CC\u51FA\u53D1\uFF0C\u6BD4\u5982\u201C\u4ECE\u5C71\u9876\u51FA\u53D1\u53BB\u9910\u5385\u201D\u3002",
      summary: (from, to, diff, km, min, via, warn) => `\u4ECE${from}\u53BB${to}\uFF0C\u53EA\u8D70${diff}\u4EE5\u4E0B\uFF0C\u7EA6${km}\u516C\u91CC\u3001${min}\u5206\u949F${via ? `\uFF0C\u7ECF\u8FC7${via}` : ""}\u3002${warn}\u8981\u51FA\u53D1\u5417\uFF1F`,
      noRoute: (reason, hint) => `${reason}${hint ? "\u3002" + hint : ""}`,
      cancelled: "\u597D\u7684\uFF0C\u53D6\u6D88\u4E86\u3002",
      nothingToConfirm: "\u73B0\u5728\u6CA1\u6709\u5F85\u786E\u8BA4\u7684\u8DEF\u7EBF\u3002\u544A\u8BC9\u6211\u60F3\u53BB\u54EA\u91CC\u5427\u3002",
      stopped: "\u5DF2\u7ED3\u675F\u5BFC\u822A\u3002",
      notNavigating: "\u73B0\u5728\u6CA1\u6709\u5728\u5BFC\u822A\u3002",
      paused: "\u5DF2\u6682\u505C\u5BFC\u822A\u3002\u8BF4\u201C\u7EE7\u7EED\u201D\u5C31\u6062\u590D\u3002",
      resumed: "\u7EE7\u7EED\u5BFC\u822A\u3002",
      unreliable: (why) => `${why}\uFF0C\u6682\u65F6\u65E0\u6CD5\u5224\u65AD\u8DDD\u79BB\u3002`,
      distance: (d, next, rem) => `${next ? `${next}\u3002` : ""}${rem != null ? `\u5230\u76EE\u7684\u5730\u8FD8\u6709\u7EA6${rem}\u3002` : ""}`,
      arrivedAlready: "\u5DF2\u7ECF\u5230\u8FBE\u76EE\u7684\u5730\u4E86\u3002",
      where: (edge) => `\u4F60\u73B0\u5728\u5927\u6982\u5728${edge}\u3002`,
      whereUnknown: "\u6682\u65F6\u65E0\u6CD5\u786E\u5B9A\u4F60\u5728\u54EA\u6761\u96EA\u9053\u4E0A\u3002",
      easierNone: "\u5DF2\u7ECF\u662F\u6700\u7B80\u5355\u7684\u8DEF\u7EBF\u4E86\u3002",
      easierNoRoute: (diff, to) => `\u53BB${to}\u6CA1\u6709\u53EA\u8D70${diff}\u7684\u8DEF\u7EBF\uFF0C\u7EE7\u7EED\u6309\u539F\u6765\u7684\u8DEF\u7EBF\u8D70\u3002`,
      unknown: "\u6211\u6CA1\u542C\u61C2\u3002\u4F60\u53EF\u4EE5\u8BF4\uFF1A\u53BB\u5C71\u811A\u9910\u5385\uFF0C\u4E0D\u8D70\u9AD8\u7EA7\u9053\uFF1B\u6216\u8005\uFF1A\u8FD8\u6709\u591A\u8FDC\u3002",
      noRepeat: "\u8FD8\u6CA1\u6709\u53EF\u4EE5\u91CD\u590D\u7684\u63D0\u793A\u3002",
      km: (m) => m >= 1e3 ? `${(m / 1e3).toFixed(1)}\u516C\u91CC` : `${Math.round(m / 10) * 10}\u7C73`,
      sep: "\u3001",
      warnUnknownOpen: "\u6CE8\u610F\u5F00\u653E\u72B6\u6001\u672A\u77E5\u3002"
    },
    ja: {
      noDest: (ex) => `\u3069\u3053\u3078\u884C\u304D\u307E\u3059\u304B\uFF1F\u4F8B\u3048\u3070\uFF1A${ex}`,
      notFound: (q, ex) => `\u5730\u56F3\u306B\u300C${q}\u300D\u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093\u3002\u884C\u3051\u308B\u5834\u6240\uFF1A${ex}`,
      ambiguous: (list) => `${list.join("\u3068")}\u306E\u3069\u3061\u3089\u3067\u3059\u304B\uFF1F`,
      noStart: "\u73FE\u5728\u5730\u304C\u307E\u3060\u308F\u304B\u308A\u307E\u305B\u3093\u3002\u300C\u5C71\u9802\u304B\u3089\u30EC\u30B9\u30C8\u30E9\u30F3\u3078\u300D\u306E\u3088\u3046\u306B\u51FA\u767A\u5730\u3092\u8A00\u3063\u3066\u304F\u3060\u3055\u3044\u3002",
      summary: (from, to, diff, km, min, via, warn) => `${from}\u304B\u3089${to}\u307E\u3067\u3001${diff}\u4EE5\u4E0B\u306E\u30B3\u30FC\u30B9\u3067\u7D04${km}\u3001${min}\u5206\u3067\u3059${via ? `\u3002${via}\u3092\u901A\u308A\u307E\u3059` : ""}\u3002${warn}\u51FA\u767A\u3057\u307E\u3059\u304B\uFF1F`,
      noRoute: (reason, hint) => `${reason}${hint ? "\u3002" + hint : ""}`,
      cancelled: "\u308F\u304B\u308A\u307E\u3057\u305F\u3001\u30AD\u30E3\u30F3\u30BB\u30EB\u3057\u307E\u3059\u3002",
      nothingToConfirm: "\u78BA\u8A8D\u5F85\u3061\u306E\u30EB\u30FC\u30C8\u306F\u3042\u308A\u307E\u305B\u3093\u3002\u884C\u304D\u5148\u3092\u6559\u3048\u3066\u304F\u3060\u3055\u3044\u3002",
      stopped: "\u6848\u5185\u3092\u7D42\u4E86\u3057\u307E\u3057\u305F\u3002",
      notNavigating: "\u4ECA\u306F\u6848\u5185\u3057\u3066\u3044\u307E\u305B\u3093\u3002",
      paused: "\u6848\u5185\u3092\u4E00\u6642\u505C\u6B62\u3057\u307E\u3057\u305F\u3002\u300C\u518D\u958B\u300D\u3067\u623B\u308A\u307E\u3059\u3002",
      resumed: "\u6848\u5185\u3092\u518D\u958B\u3057\u307E\u3059\u3002",
      unreliable: (why) => `${why}\u306E\u305F\u3081\u3001\u8DDD\u96E2\u304C\u308F\u304B\u308A\u307E\u305B\u3093\u3002`,
      distance: (d, next, rem) => `${next ? `${next}\u3002` : ""}${rem != null ? `\u76EE\u7684\u5730\u307E\u3067\u3042\u3068\u7D04${rem}\u3067\u3059\u3002` : ""}`,
      arrivedAlready: "\u3082\u3046\u76EE\u7684\u5730\u306B\u7740\u3044\u3066\u3044\u307E\u3059\u3002",
      where: (edge) => `\u4ECA\u306F\u304A\u305D\u3089\u304F${edge}\u306B\u3044\u307E\u3059\u3002`,
      whereUnknown: "\u4ECA\u3069\u306E\u30B3\u30FC\u30B9\u306B\u3044\u308B\u304B\u7279\u5B9A\u3067\u304D\u307E\u305B\u3093\u3002",
      easierNone: "\u3059\u3067\u306B\u4E00\u756A\u3084\u3055\u3057\u3044\u30EB\u30FC\u30C8\u3067\u3059\u3002",
      easierNoRoute: (diff, to) => `${to}\u307E\u3067${diff}\u3060\u3051\u306E\u30EB\u30FC\u30C8\u306F\u3042\u308A\u307E\u305B\u3093\u3002\u4ECA\u306E\u30EB\u30FC\u30C8\u3092\u7D9A\u3051\u307E\u3059\u3002`,
      unknown: "\u3088\u304F\u308F\u304B\u308A\u307E\u305B\u3093\u3067\u3057\u305F\u3002\u300C\u5C71\u9E93\u30EC\u30B9\u30C8\u30E9\u30F3\u3078\u3001\u4E0A\u7D1A\u30B3\u30FC\u30B9\u306A\u3057\u300D\u3084\u300C\u3042\u3068\u3069\u308C\u304F\u3089\u3044\u300D\u3068\u8A00\u3063\u3066\u304F\u3060\u3055\u3044\u3002",
      noRepeat: "\u307E\u3060\u7E70\u308A\u8FD4\u3059\u6848\u5185\u304C\u3042\u308A\u307E\u305B\u3093\u3002",
      km: (m) => m >= 1e3 ? `${(m / 1e3).toFixed(1)}\u30AD\u30ED` : `${Math.round(m / 10) * 10}\u30E1\u30FC\u30C8\u30EB`,
      sep: "\u3001",
      warnUnknownOpen: "\u55B6\u696D\u72B6\u6CC1\u306F\u4E0D\u660E\u3067\u3059\u3002"
    }
  };
  function createCompanion(api) {
    let mode = "idle";
    let pending = null;
    let prefs = { maxDifficulty: 2, avoidFlat: false, preferShort: false };
    let lastReply = "";
    const t = () => T[api.lang() === "ja" ? "ja" : "zh"];
    const placeExamples = () => api.resort.pois.slice(0, 4).map((p) => api.lang() === "ja" && p.name_ja || p.name).join(t().sep);
    const placeName = (node) => {
      const p = api.resort.pois.find((x) => x.node === node);
      if (p) return api.lang() === "ja" && p.name_ja || p.name;
      return api.resort.nodes.get(node)?.name || node;
    };
    function locateStart() {
      const fix = api.lastFix();
      if (!fix) return null;
      const cands = matchFix(api.resort, fix, { heading: null, moving: false, prevEdge: null });
      const c = cands.find((x) => x.d <= Math.max(40, (fix.acc || 10) * 1.5));
      if (c) return { startEdgeId: c.edge.id, label: api.edgeLabel(c.edge) };
      let best = null;
      for (const n of api.resort.nodes.values()) {
        const d = Math.hypot(n.x - fix.x, n.y - fix.y);
        if (d <= 150 && (!best || d < best.d)) best = { node: n.id, d };
      }
      return best ? { startNode: best.node, label: placeName(best.node) } : null;
    }
    function summarize2(p, fromLabel, goal) {
      const L = t();
      const diffName = (api.lang() === "ja" ? DIFF_JA : DIFF_ZH)[p.prefs.maxDifficulty] || "";
      const runs = p.edges.filter((e) => e.type === "run" && e.ref).map((e) => api.lang() === "ja" ? `${e.ref}\u756A` : `${e.ref}\u53F7`);
      const via = [...new Set(runs)].slice(0, 4).join(L.sep);
      const km = api.lang() === "ja" ? L.km(p.length) : (p.length / 1e3).toFixed(1);
      const warn = p.edges.some((e) => e.open == null) ? L.warnUnknownOpen : "";
      return L.summary(fromLabel, placeName(goal), diffName, km, Math.max(1, Math.round(p.time / 60)), via, warn);
    }
    function fail(text) {
      pending = null;
      mode = api.isNavigating() ? "navigating" : "idle";
      return say(text, { planned: false });
    }
    function planAndConfirm(intent) {
      const L = t();
      const dest = resolvePlace(api.resort, intent.destination);
      if (!intent.destination && !pending) return fail(L.noDest(placeExamples()));
      let goal = pending?.goal;
      if (intent.destination) {
        if (!dest) return fail(L.notFound(intent.destination, placeExamples()));
        if (dest.ambiguous) return fail(L.ambiguous(dest.ambiguous));
        goal = dest.node;
      }
      let start = null, fromLabel = "";
      if (intent.start) {
        const s = resolvePlace(api.resort, intent.start);
        if (!s) return fail(L.notFound(intent.start, placeExamples()));
        if (s.ambiguous) return fail(L.ambiguous(s.ambiguous));
        start = { startNode: s.node };
        fromLabel = placeName(s.node);
      } else if (api.isNavigating() && api.currentEdge()) {
        start = { startEdgeId: api.currentEdge().id };
        fromLabel = api.edgeLabel(api.currentEdge());
      } else if (api.usesGps()) {
        const loc = locateStart();
        if (!loc) return fail(L.noStart);
        start = loc;
        fromLabel = loc.label;
      } else {
        const n = api.defaultStart();
        if (!n) return fail(L.noStart);
        start = { startNode: n };
        fromLabel = placeName(n);
      }
      const want = { ...prefs };
      if (intent.maxDifficulty) want.maxDifficulty = intent.maxDifficulty;
      if (intent.avoidFlat) want.avoidFlat = intent.avoidFlat === "yes";
      if (intent.preferShort) want.preferShort = intent.preferShort === "yes";
      const p = api.plan({ ...start, goalNode: goal }, want);
      if (!p.ok) {
        return fail(L.noRoute(p.reason, (p.hints || []).join("\uFF1B")));
      }
      prefs = want;
      pending = { ...start, goal, prefs: { ...p.prefs }, plan: p, fromLabel };
      mode = "confirming";
      return say(summarize2(p, fromLabel, goal), { awaiting: true, planned: true });
    }
    function say(text, extra = {}) {
      if (text) lastReply = text;
      return { say: text, mode, ...extra };
    }
    function handle(intent) {
      const L = t();
      const it = { ...EMPTY, ...intent || {} };
      if (it.maxDifficulty && !(it.maxDifficulty >= 1 && it.maxDifficulty <= 4)) it.maxDifficulty = 0;
      if (api.isNavigating() && mode !== "confirming") mode = "navigating";
      if (!api.isNavigating() && mode === "navigating") mode = "idle";
      switch (it.intent) {
        case "navigate":
          return planAndConfirm(it);
        case "confirm": {
          if (mode !== "confirming" || !pending) return say(L.nothingToConfirm);
          const r = api.startNav(pending.plan, pending.goal, pending.prefs);
          if (!r.ok) {
            mode = "idle";
            return say(r.reason);
          }
          mode = "navigating";
          pending = null;
          return say("", { event: "started" });
        }
        case "cancel":
          if (mode === "confirming") {
            pending = null;
            mode = api.isNavigating() ? "navigating" : "idle";
            return say(L.cancelled);
          }
          return say(L.cancelled);
        case "stop":
          pending = null;
          if (!api.isNavigating()) {
            mode = "idle";
            return say(L.notNavigating);
          }
          api.stopNav();
          mode = "idle";
          return say(L.stopped, { event: "stopped" });
        case "pause":
          if (!api.isNavigating()) return say(L.notNavigating);
          api.pause();
          return say(L.paused, { event: "paused" });
        case "resume":
          if (!api.isNavigating()) return say(L.notNavigating);
          api.resume();
          return say(L.resumed, { event: "resumed" });
        case "repeat": {
          const r = api.replay() || lastReply;
          return r ? { say: r, mode } : say(L.noRepeat);
        }
        case "distance": {
          if (!api.isNavigating()) return say(L.notNavigating);
          const s = api.snapshot();
          if (s.state === "arrived") return say(L.arrivedAlready);
          if (s.unreliable || s.stale) return say(L.unreliable(s.unreliable || ""));
          const d = s.distToNext != null ? Math.round(s.distToNext / 10) * 10 : null;
          const next = d != null && d > 60 && s.nextPreview ? s.nextPreview : s.nextText || "";
          return say(L.distance(d, next, s.remaining != null ? L.km(s.remaining) : null));
        }
        case "where": {
          const e = api.isNavigating() ? api.currentEdge() : null;
          if (e) return say(L.where(api.edgeLabel(e)));
          const loc = api.usesGps() ? locateStart() : null;
          return say(loc ? L.where(loc.label) : L.whereUnknown);
        }
        case "easier": {
          const cur = (pending?.prefs || api.navPrefs() || prefs).maxDifficulty || prefs.maxDifficulty;
          if (cur <= 1) return say(L.easierNone);
          const goal = pending?.goal || api.navGoal();
          if (!goal) {
            prefs.maxDifficulty = cur - 1;
            return say(L.noDest(placeExamples()));
          }
          const hadPending = !!pending;
          pending = pending || { goal };
          const r = planAndConfirm({ ...EMPTY, intent: "navigate", maxDifficulty: cur - 1 });
          if (r.mode !== "confirming") {
            if (!hadPending) pending = null;
            return say(L.easierNoRoute((api.lang() === "ja" ? DIFF_JA : DIFF_ZH)[cur - 1], placeName(goal)));
          }
          return r;
        }
        case "chat":
          return say((it.reply || "").slice(0, 120) || L.unknown);
        default:
          return say(L.unknown);
      }
    }
    function facts() {
      if (!pending?.plan) return null;
      const p = pending.plan;
      const runs = [...new Set(p.edges.filter((e) => e.type !== "connector").map((e) => api.edgeLabel(e)))];
      return {
        from: pending.fromLabel || "",
        to: placeName(pending.goal),
        distance_km: Math.round(p.length / 100) / 10,
        minutes: Math.max(1, Math.round(p.time / 60)),
        max_difficulty: DIFF_ZH[pending.prefs.maxDifficulty] || "",
        lifts: p.liftCount || 0,
        route: runs,
        warnings: p.warnings || []
      };
    }
    function statusFacts() {
      if (!api.isNavigating()) return { navigating: false, mode, pending_route: facts() };
      const s = api.snapshot();
      const e = api.currentEdge();
      const d = s.distToNext != null ? Math.round(s.distToNext / 10) * 10 : null;
      return {
        navigating: true,
        state: s.stateZh || s.state,
        location_unreliable: s.unreliable || (s.stale ? "\u5B9A\u4F4D\u4E2D\u65AD" : null),
        next_instruction: d != null && d > 60 && s.nextPreview ? s.nextPreview : s.nextText || null,
        distance_to_next_fork_m: d,
        remaining_km: s.remaining != null ? Math.round(s.remaining / 100) / 10 : null,
        speed_kmh: s.speed != null ? Math.round(s.speed * 3.6) : null,
        current_run: e ? api.edgeLabel(e) : null,
        destination: api.navGoal() ? placeName(api.navGoal()) : null
      };
    }
    function tool(name, args = {}) {
      const a = args || {};
      const yn = (v) => v === true ? "yes" : v === false ? "no" : "";
      let r;
      switch (name) {
        case "plan_route":
          r = handle({
            ...EMPTY,
            intent: "navigate",
            destination: a.destination || "",
            start: a.start || "",
            maxDifficulty: a.max_difficulty || 0,
            avoidFlat: yn(a.avoid_flat),
            preferShort: yn(a.prefer_short)
          });
          return {
            planned: !!r.planned,
            ref: r.say,
            route: r.planned ? facts() : null,
            note: r.planned ? "\u8FD8\u6CA1\u51FA\u53D1\uFF1A\u628A\u8DEF\u7EBF\u7B80\u77ED\u544A\u8BC9\u7528\u6237\u5E76\u95EE\u8981\u4E0D\u8981\u51FA\u53D1\uFF0C\u7528\u6237\u540C\u610F\u540E\u518D\u8C03\u7528 start_navigation" : null
          };
        case "easier_route":
          r = handle({ ...EMPTY, intent: "easier" });
          return { planned: !!r.planned, ref: r.say, route: r.planned ? facts() : null };
        case "start_navigation":
          r = handle({ ...EMPTY, intent: "confirm" });
          return { started: r.event === "started", ref: r.say || null, event: r.event || null };
        case "cancel_route":
          r = handle({ ...EMPTY, intent: "cancel" });
          return { ok: true };
        case "control_navigation": {
          const intent = { stop: "stop", pause: "pause", resume: "resume" }[a.action];
          if (!intent) return { ok: false, error: "action \u53EA\u80FD\u662F stop / pause / resume" };
          r = handle({ ...EMPTY, intent });
          return { ok: !!r.event, ref: r.say, event: r.event || null };
        }
        case "get_status":
          return statusFacts();
        case "repeat_instruction": {
          const t2 = api.replay() || lastReply;
          return { instruction: t2 || null };
        }
        default:
          return { error: `\u6CA1\u6709\u8FD9\u4E2A\u5DE5\u5177\uFF1A${name}` };
      }
    }
    return {
      handle,
      tool,
      status: statusFacts,
      get mode() {
        return mode;
      },
      get pending() {
        return pending;
      },
      get prefs() {
        return { ...prefs };
      },
      setPrefs(p) {
        prefs = { ...prefs, ...p };
      },
      reset() {
        mode = "idle";
        pending = null;
      }
    };
  }
  function brainSystemPrompt(resort, lang) {
    const places = resort.pois.map((p) => {
      const names = [p.name, p.name_ja, ...p.aliases || []].filter(Boolean);
      return `- ${names.join(" / ")}`;
    }).join("\n");
    return [
      "\u4F60\u662F\u201C\u96EA\u4EBA\u201D\uFF0C\u4E00\u4E2A\u6ED1\u96EA\u8BED\u97F3\u5BFC\u822A\u4F19\u4F34\u7684\u8BED\u8A00\u7406\u89E3\u6A21\u5757\u3002\u7528\u6237\u6234\u7740\u624B\u5957\u5728\u96EA\u9053\u4E0A\uFF0C\u7528\u4E2D\u6587\u6216\u65E5\u8BED\u5BF9\u624B\u673A\u8BF4\u8BDD\uFF08\u8BED\u97F3\u8BC6\u522B\u7ED3\u679C\u53EF\u80FD\u6709\u9519\u5B57\uFF09\u3002",
      "\u4F60\u7684\u552F\u4E00\u4EFB\u52A1\uFF1A\u628A\u7528\u6237\u8FD9\u4E00\u53E5\u8BDD\u7406\u89E3\u6210\u4E00\u4E2A\u610F\u56FE JSON\u3002\u4F60\u4E0D\u89C4\u5212\u8DEF\u7EBF\u3001\u4E0D\u51B3\u5B9A\u8D70\u54EA\u6761\u96EA\u9053\u3001\u4E0D\u7ED9\u8F6C\u5F2F\u6307\u4EE4\u2014\u2014\u8FD9\u4E9B\u7531\u5BFC\u822A\u7A0B\u5E8F\u6839\u636E\u5730\u56FE\u5B8C\u6210\u3002",
      "",
      "\u610F\u56FE\uFF1A",
      "- navigate\uFF1A\u60F3\u53BB\u67D0\u5730\uFF0C\u6216\u4FEE\u6539\u8DEF\u7EBF\u6761\u4EF6\uFF08\u96BE\u5EA6\u3001\u907F\u5F00\u5E73\u8DEF\u3001\u6700\u77ED\uFF09\u3002destination \u586B\u5730\u70B9\u8868\u91CC\u7684\u540D\u79F0\uFF08\u7528\u8868\u91CC\u5199\u6CD5\uFF09\uFF1B\u7528\u6237\u8BF4\u4E86\u51FA\u53D1\u5730\u624D\u586B start\u3002",
      "- confirm\uFF1A\u540C\u610F/\u786E\u8BA4\u51FA\u53D1\uFF08\u597D\u3001\u8D70\u5427\u3001\u53EF\u4EE5\uFF09\u3002cancel\uFF1A\u4E0D\u8981\u3001\u7B97\u4E86\u3002",
      "- stop\uFF1A\u7ED3\u675F\u5BFC\u822A\u3002pause / resume\uFF1A\u6682\u505C / \u7EE7\u7EED\u5BFC\u822A\u3002",
      "- distance\uFF1A\u95EE\u8FD8\u6709\u591A\u8FDC/\u591A\u4E45\u3002repeat\uFF1A\u6CA1\u542C\u6E05\u3001\u518D\u8BF4\u4E00\u904D\u3002easier\uFF1A\u60F3\u8D70\u66F4\u7B80\u5355/\u8F7B\u677E\u7684\u8DEF\u3002where\uFF1A\u95EE\u81EA\u5DF1\u5728\u54EA\u3002",
      "- chat\uFF1A\u95F2\u804A\u3001\u6253\u62DB\u547C\u3001\u60C5\u7EEA\u8868\u8FBE\u3001\u4E0E\u5BFC\u822A\u65E0\u5173\u7684\u95EE\u9898\u3002reply \u586B\u4E00\u53E5\u7B80\u77ED\u53CB\u597D\u7684\u56DE\u590D\uFF08\u4E0D\u8D85\u8FC7 40 \u5B57\uFF0C\u7528\u7528\u6237\u7684\u8BED\u8A00\uFF09\uFF0C\u4E0D\u8981\u7ED9\u4EFB\u4F55\u8DEF\u7EBF\u6216\u96EA\u9053\u5EFA\u8BAE\uFF0C\u4E0D\u8981\u7F16\u9020\u96EA\u573A\u4FE1\u606F\u3002",
      "- unknown\uFF1A\u542C\u4E0D\u61C2\u6216\u8BED\u97F3\u8BC6\u522B\u660E\u663E\u9519\u4E71\u3002",
      "",
      "\u96BE\u5EA6 maxDifficulty\uFF1A1 \u521D\u7EA7\uFF08\u7EFF\uFF09\u30012 \u4E2D\u7EA7\uFF08\u7EA2\uFF09\u30013 \u9AD8\u7EA7\uFF08\u9ED1/\u4E0A\u7EA7\uFF09\u30014 \u4E13\u5BB6\uFF1B\u201C\u4E0D\u8D70\u9AD8\u7EA7\u9053\u201D= 2\uFF0C\u201C\u53EA\u8D70\u521D\u7EA7\u201D= 1\uFF0C\u6CA1\u63D0\u5230 = 0\u3002",
      'avoidFlat\uFF1A\u6015\u5E73\u8DEF/\u4E0D\u60F3\u8E6C/\u4E0D\u60F3\u8D70\u8DEF = "yes"\uFF1BpreferShort\uFF1A\u8981\u6700\u77ED\u6700\u5FEB = "yes"\uFF1B\u6CA1\u63D0\u5230 = ""\u3002',
      "\u4E0D\u9700\u8981\u7684\u5B57\u6BB5\u586B\u7A7A\u5B57\u7B26\u4E32\u6216 0\u3002\u53EA\u80FD\u7528\u4E0B\u9762\u5730\u70B9\u8868\u91CC\u7684\u5730\u70B9\uFF1B\u7528\u6237\u8BF4\u7684\u5730\u70B9\u4E0D\u5728\u8868\u91CC\u65F6\uFF0Cdestination \u539F\u6837\u586B\u7528\u6237\u7684\u8BF4\u6CD5\uFF08\u7A0B\u5E8F\u4F1A\u8FFD\u95EE\uFF09\u3002",
      `\u5F53\u524D\u64AD\u62A5\u8BED\u8A00\uFF1A${lang === "ja" ? "\u65E5\u8BED" : "\u4E2D\u6587"}\u3002`,
      "",
      `\u96EA\u573A\uFF1A${resort.name}`,
      "\u5730\u70B9\u8868\uFF1A",
      places
    ].join("\n");
  }
  var COMPANION_TOOLS = [
    {
      name: "plan_route",
      description: "\u89C4\u5212\u53BB\u67D0\u4E2A\u5730\u70B9\u7684\u8DEF\u7EBF\uFF08\u4E0D\u4F1A\u51FA\u53D1\uFF09\u3002\u7528\u6237\u60F3\u53BB\u67D0\u5730\u3001\u6216\u60F3\u6539\u96BE\u5EA6/\u907F\u5F00\u5E73\u8DEF/\u8D70\u6700\u77ED\u65F6\u8C03\u7528\u3002\u8FD4\u56DE\u8DEF\u7EBF\u4E8B\u5B9E\uFF1B\u5730\u70B9\u627E\u4E0D\u5230\u6216\u6709\u6B67\u4E49\u65F6 ref \u91CC\u4F1A\u8BF4\u660E\uFF0C\u9700\u8981\u5411\u7528\u6237\u8FFD\u95EE\u3002",
      input_schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          destination: { type: "string", description: "\u76EE\u7684\u5730\u540D\u79F0\uFF0C\u5C3D\u91CF\u7528\u5730\u70B9\u8868\u91CC\u7684\u5199\u6CD5\uFF1B\u53EA\u6539\u6761\u4EF6\u65F6\u53EF\u4E3A\u7A7A" },
          start: { type: "string", description: "\u7528\u6237\u660E\u786E\u8BF4\u4E86\u51FA\u53D1\u5730\u624D\u586B\uFF0C\u5426\u5219\u4E0D\u586B\uFF08\u7A0B\u5E8F\u7528\u5F53\u524D\u4F4D\u7F6E\uFF09" },
          max_difficulty: { type: "integer", enum: [1, 2, 3, 4], description: "\u96BE\u5EA6\u4E0A\u9650\uFF1A1 \u521D\u7EA7 2 \u4E2D\u7EA7 3 \u9AD8\u7EA7 4 \u4E13\u5BB6\uFF1B\u7528\u6237\u6CA1\u63D0\u5C31\u4E0D\u586B" },
          avoid_flat: { type: "boolean", description: "\u7528\u6237\u6015\u5E73\u8DEF/\u4E0D\u60F3\u8E6C/\u4E0D\u60F3\u8D70\u8DEF" },
          prefer_short: { type: "boolean", description: "\u7528\u6237\u8981\u6700\u77ED/\u6700\u5FEB" }
        },
        required: []
      }
    },
    { name: "start_navigation", description: "\u7528\u6237\u540C\u610F\u51FA\u53D1\u540E\uFF0C\u6309\u521A\u89C4\u5212\u597D\u7684\u8DEF\u7EBF\u5F00\u59CB\u5BFC\u822A\u3002", input_schema: { type: "object", additionalProperties: false, properties: {}, required: [] } },
    { name: "cancel_route", description: "\u7528\u6237\u4E0D\u8981\u521A\u89C4\u5212\u7684\u8DEF\u7EBF\u4E86\u3002", input_schema: { type: "object", additionalProperties: false, properties: {}, required: [] } },
    { name: "easier_route", description: "\u7528\u6237\u7D2F\u4E86/\u89C9\u5F97\u96BE\uFF0C\u60F3\u6362\u66F4\u7B80\u5355\u7684\u8DEF\u7EBF\uFF08\u96BE\u5EA6\u964D\u4E00\u7EA7\uFF0C\u4ECE\u5F53\u524D\u4F4D\u7F6E\u91CD\u65B0\u89C4\u5212\uFF0C\u4E0D\u4F1A\u81EA\u52A8\u51FA\u53D1\uFF09\u3002", input_schema: { type: "object", additionalProperties: false, properties: {}, required: [] } },
    {
      name: "control_navigation",
      description: "\u7ED3\u675F\u3001\u6682\u505C\u6216\u7EE7\u7EED\u5BFC\u822A\u3002",
      input_schema: { type: "object", additionalProperties: false, properties: { action: { type: "string", enum: ["stop", "pause", "resume"] } }, required: ["action"] }
    },
    { name: "get_status", description: "\u67E5\u5BFC\u822A\u72B6\u6001\uFF1A\u4E0B\u4E00\u6761\u63D0\u793A\u3001\u5230\u4E0B\u4E00\u4E2A\u5C94\u53E3\u7684\u8DDD\u79BB\u3001\u5269\u4F59\u8DDD\u79BB\u3001\u901F\u5EA6\u3001\u6240\u5728\u96EA\u9053\u3001\u5B9A\u4F4D\u662F\u5426\u53EF\u9760\u3002\u7528\u6237\u95EE\u8FD8\u6709\u591A\u8FDC\u3001\u5728\u54EA\u3001\u591A\u5FEB\u65F6\u8C03\u7528\u3002", input_schema: { type: "object", additionalProperties: false, properties: {}, required: [] } },
    { name: "repeat_instruction", description: "\u7528\u6237\u6CA1\u542C\u6E05\u5BFC\u822A\u63D0\u793A\u65F6\uFF0C\u53D6\u5F53\u524D\u7684\u5BFC\u822A\u63D0\u793A\u539F\u6587\u3002", input_schema: { type: "object", additionalProperties: false, properties: {}, required: [] } }
  ];
  function companionSystemPrompt(resort, lang) {
    const places = resort.pois.map((p) => `- ${[p.name, p.name_ja, ...p.aliases || []].filter(Boolean).join(" / ")}`).join("\n");
    const ja = lang === "ja";
    return [
      "\u4F60\u662F\u201C\u96EA\u4EBA\u201D\uFF0C\u7528\u6237\u7684\u6ED1\u96EA\u966A\u6ED1\u4F19\u4F34\uFF0C\u4E5F\u662F\u4E2A\u61C2\u884C\u7684\u6559\u7EC3\u3002\u7528\u6237\u6234\u7740\u624B\u5957\u3001\u5728\u96EA\u9053\u4E0A\u6216\u7F06\u8F66\u4E0A\uFF0C\u901A\u8FC7\u8BED\u97F3\u548C\u4F60\u8BF4\u8BDD\uFF08\u8BED\u97F3\u8BC6\u522B\u53EF\u80FD\u6709\u9519\u5B57\uFF0C\u6309\u610F\u601D\u7406\u89E3\uFF09\u3002",
      "",
      "\u8BF4\u8BDD\u65B9\u5F0F\uFF1A",
      `- \u4F60\u7684\u56DE\u590D\u4F1A\u88AB\u76F4\u63A5\u6717\u8BFB\u51FA\u6765\u3002\u7528${ja ? "\u65E5\u8BED" : "\u4E2D\u6587"}\u53E3\u8BED\uFF0C\u50CF\u670B\u53CB\u4E00\u6837\u81EA\u7136\u3001\u4EB2\u5207\uFF0C\u53EF\u4EE5\u8F7B\u677E\u5E7D\u9ED8\u3002`,
      "- \u77ED\uFF01\u4E00\u822C\u4E00\u4E24\u53E5\u8BDD\uFF0C\u4E0D\u8D85\u8FC7 40 \u4E2A\u5B57\u3002\u4E0D\u7528\u5217\u8868\u3001\u7F16\u53F7\u3001\u62EC\u53F7\u3001\u8868\u60C5\u7B26\u53F7\u3001\u82F1\u6587\u7F29\u5199\u3002",
      "- \u7528\u6237\u5728\u6ED1\u884C\u4E2D\uFF08\u5BFC\u822A\u4E2D\uFF09\u65F6\u66F4\u8981\u7B80\u77ED\uFF0C\u522B\u5206\u6563\u6CE8\u610F\u529B\uFF1B\u5728\u7F06\u8F66\u4E0A\u3001\u4F11\u606F\u65F6\u53EF\u4EE5\u591A\u804A\u4E24\u53E5\u3002",
      "- \u53EF\u4EE5\u9F13\u52B1\u3001\u5938\u5956\u3001\u5173\u5FC3\u4F53\u529B\u548C\u5B89\u5168\uFF1B\u53EF\u4EE5\u7ED9\u901A\u7528\u7684\u6ED1\u96EA\u6280\u672F\u5EFA\u8BAE\uFF08\u91CD\u5FC3\u3001\u7ACB\u5203\u3001\u8F6C\u5F2F\u8282\u594F\u3001\u770B\u8FDC\u5904\u7B49\uFF09\uFF0C\u4F46\u4E0D\u8981\u957F\u7BC7\u8BF4\u6559\u3002",
      "",
      "\u5BFC\u822A\u89C4\u5219\uFF08\u5FC5\u987B\u9075\u5B88\uFF09\uFF1A",
      "- \u8DEF\u7EBF\u3001\u96EA\u9053\u3001\u8DDD\u79BB\u3001\u65F6\u95F4\u3001\u5F00\u653E\u72B6\u6001\u53EA\u80FD\u6765\u81EA\u5DE5\u5177\u7ED3\u679C\uFF0C\u7EDD\u4E0D\u7F16\u9020\u3002\u5730\u56FE\u4E0A\u6CA1\u6709\u7684\u5730\u65B9\u5C31\u8BF4\u627E\u4E0D\u5230\uFF0C\u8BA9\u7528\u6237\u6362\u4E2A\u8BF4\u6CD5\u3002",
      "- \u7528\u6237\u60F3\u53BB\u67D0\u5730 \u2192 \u8C03 plan_route\uFF0C\u628A\u7ED3\u679C\u7528\u81EA\u5DF1\u7684\u8BDD\u7B80\u77ED\u8BF4\u51FA\u6765\uFF08\u4ECE\u54EA\u5230\u54EA\u3001\u5927\u6982\u591A\u8FDC\u591A\u4E45\u3001\u6700\u96BE\u4EC0\u4E48\u7EA7\u522B\uFF09\uFF0C\u7136\u540E\u95EE\u8981\u4E0D\u8981\u51FA\u53D1\u3002",
      "- \u7528\u6237\u540C\u610F\u51FA\u53D1 \u2192 \u8C03 start_navigation\u3002\u5F00\u59CB\u540E\u7B80\u77ED\u8BF4\u4E00\u53E5\u5C31\u884C\uFF0C\u8F6C\u5F2F\u63D0\u793A\u7531\u5BFC\u822A\u81EA\u52A8\u64AD\u62A5\uFF0C\u4F60\u4E0D\u8981\u81EA\u5DF1\u7ED9\u8F6C\u5F2F\u6307\u4EE4\u3002",
      "- \u95EE\u8FD8\u6709\u591A\u8FDC\u3001\u5728\u54EA\u3001\u591A\u5FEB \u2192 \u8C03 get_status \u518D\u56DE\u7B54\u3002\u6CA1\u542C\u6E05\u63D0\u793A \u2192 repeat_instruction\u3002\u7D2F\u4E86\u60F3\u7B80\u5355\u70B9 \u2192 easier_route\u3002",
      "- \u5DE5\u5177\u8BF4\u5B9A\u4F4D\u4E0D\u53EF\u9760\u65F6\uFF0C\u5982\u5B9E\u544A\u8BC9\u7528\u6237\uFF0C\u4E0D\u8981\u731C\u8DDD\u79BB\u548C\u65B9\u5411\u3002",
      "- \u5B89\u5168\u7B2C\u4E00\uFF1A\u4E0D\u9F13\u52B1\u8D85\u51FA\u80FD\u529B\u7684\u96BE\u5EA6\u3001\u4E0D\u5EFA\u8BAE\u8FDB\u5165\u5173\u95ED\u6216\u672A\u77E5\u7684\u533A\u57DF\uFF1B\u7528\u6237\u8BF4\u53D7\u4F24\u3001\u8FF7\u8DEF\u3001\u5F88\u51B7\u5F88\u7D2F\u65F6\uFF0C\u5EFA\u8BAE\u505C\u5728\u5B89\u5168\u7684\u5730\u65B9\u3001\u8054\u7CFB\u96EA\u573A\u5DE1\u903B\u6216\u540C\u4F34\u3002",
      "- \u7528\u6237\u53EA\u662F\u95F2\u804A\u5C31\u966A\u7740\u804A\uFF0C\u4E0D\u9700\u8981\u8C03\u5DE5\u5177\u3002",
      "",
      `\u96EA\u573A\uFF1A${resort.name}${resort.dataStatus === "fictional" ? "\uFF08\u865A\u6784\u7684\u6F14\u793A\u96EA\u573A\uFF09" : resort.dataStatus === "unverified" ? "\uFF08\u5730\u56FE\u6570\u636E\u672A\u6838\u5B9E\uFF0C\u5F00\u653E\u72B6\u6001\u672A\u77E5\uFF09" : ""}`,
      "\u5730\u70B9\u8868\uFF1A",
      places
    ].join("\n");
  }

  // nav/core-entry.js
  var J = (x) => JSON.stringify(x);
  function scenarioTexts(resortJsonText, opts) {
    const r = loadResort(JSON.parse(resortJsonText));
    if (r.errors.length) return J({ ok: false, errors: r.errors });
    const res = runScenario(r, JSON.parse(opts || "{}"));
    return J({ ok: true, texts: res.spoken.map((s) => s.text), arrived: res.nav.state === "arrived" });
  }
  function createSession(resortJsonText) {
    const resort = loadResort(JSON.parse(resortJsonText));
    let lang = "zh", talkLang = "zh", plan = null, prefs = { ...DEFAULT_PREFS }, nav = null, sim = null;
    let queue = [], lastSpoken = null;
    let mode = "sim", lastFix = null, defaultStart = null, simSeed = null;
    const places = () => {
      const seen = /* @__PURE__ */ new Set(), list = [];
      for (const p of resort.pois || []) {
        if (seen.has(p.node)) continue;
        seen.add(p.node);
        list.push({ node: p.node, name: p.name, nameJa: p.name_ja || null });
      }
      for (const n of resort.nodes?.values() || []) {
        if (seen.has(n.id) || !n.name) continue;
        seen.add(n.id);
        list.push({ node: n.id, name: n.name, nameJa: n.name_ja || null });
      }
      return list;
    };
    const newNav = () => new Navigator(resort, {
      lang,
      onSpeak: (item) => {
        lastSpoken = item;
        queue.push({ text: item.text, reason: item.reason, voice: item.voice !== false, key: item.key, t: item.t });
      }
    });
    let lastNow = 0;
    const nowOf = () => sim ? sim.t : lastNow;
    function startNav(p, destNode, pr, nowMs) {
      if (mode === "gps" && !resort.allowRealGps) return { ok: false, reason: "\u8FD9\u4E2A\u5730\u56FE\u4E0D\u5141\u8BB8\u771F\u5B9E GPS \u5BFC\u822A" };
      queue = [];
      lastSpoken = null;
      nav = newNav();
      if (mode === "sim") {
        sim = new Simulator(resort, { seed: simSeed ?? 3, drift: 4, carve: true });
        sim.setPath(p.edges);
        sim.follow = (node) => (nav?.route || []).slice(nav.idx).find((e) => e.from === node) || null;
        nav.start({ route: p, destNode, prefs: pr }, 0);
      } else {
        sim = null;
        nav.start({ route: p, destNode, prefs: pr }, nowMs ?? lastNow);
        if (lastFix) nav.onFix(lastFix);
      }
      plan = { ...p, destNode };
      prefs = pr;
      return { ok: true };
    }
    const isNavigating = () => !!nav && nav.state !== "idle";
    const companion = createCompanion({
      resort,
      lang: () => talkLang,
      usesGps: () => mode === "gps",
      lastFix: () => lastFix,
      defaultStart: () => defaultStart || places()[0]?.node || null,
      isNavigating,
      currentEdge: () => nav ? nav.matched?.edge || nav.route?.[nav.idx] || null : null,
      navPrefs: () => nav ? nav.prefs : null,
      navGoal: () => nav ? nav.destNode : null,
      edgeLabel,
      plan: (q, pr) => planRoute(resort, q, pr),
      startNav: (p, goal, pr) => startNav(p, goal, pr, lastNow),
      stopNav: () => {
        nav?.stop(nowOf());
        nav = null;
        sim = null;
      },
      pause: () => nav?.pause(nowOf()),
      resume: () => nav?.resume(nowOf()),
      snapshot: () => {
        const sn = nav.snapshot(nowOf());
        sn.nextPreview = sn.next && sn.distToNext != null ? maneuverText(sn.next, "preview", { lang, distance: sn.distToNext }) : null;
        return sn;
      },
      replay: () => {
        if (!nav) return lastSpoken?.text || null;
        const s = nav.snapshot(nowOf());
        return s.nextText || lastSpoken?.text || null;
      }
    });
    return {
      info() {
        return J({
          errors: resort.errors,
          warnings: resort.warnings,
          id: resort.id,
          name: resort.name,
          region: resort.region || null,
          dataStatus: resort.dataStatus,
          allowRealGps: !!resort.allowRealGps,
          disclaimer: resort.disclaimer || "",
          places: resort.errors.length ? [] : places()
        });
      },
      // lang：导航播报语言（神乐用日语，因为雪道名是假名）；talkLang：用户说话和雪人回话的语言
      setLang(l) {
        lang = l === "ja" ? "ja" : "zh";
        if (nav) nav.lang = lang;
      },
      setTalkLang(l) {
        talkLang = l === "ja" ? "ja" : "zh";
      },
      // prefsJson：{ maxDifficulty, avoidFlat, preferShort }
      plan(startNode, goalNode, prefsJson) {
        prefs = { ...DEFAULT_PREFS, ...JSON.parse(prefsJson || "{}") };
        const p = planRoute(resort, { startNode, goalNode }, prefs);
        plan = p.ok ? { ...p, destNode: goalNode } : null;
        if (!p.ok) return J({ ok: false, reason: p.reason, hints: p.hints || [] });
        const ms = buildManeuvers(resort, p.edges, goalNode);
        return J({
          ok: true,
          warnings: p.warnings,
          length: p.length,
          time: p.time,
          flatLen: p.flatLen,
          liftCount: p.liftCount,
          maxDiff: p.maxDiff,
          maxDiffZh: DIFFICULTY[p.maxDiff]?.zh || null,
          steps: p.edges.map((e) => ({ id: e.id, type: e.type, label: edgeLabel(e), length: e.length, difficulty: e.difficulty })),
          maneuvers: ms.map((m) => maneuverText(m, "main", { lang }))
        });
      },
      // mode：'sim' 用内置模拟器（时间从 0 开始，每次 simStep 前进 1 秒）；'gps' 用真实定位
      start(m, nowMs, seed) {
        if (!plan) return J({ ok: false, reason: "\u8BF7\u5148\u89C4\u5212\u8DEF\u7EBF" });
        mode = m === "gps" ? "gps" : "sim";
        simSeed = seed;
        return J(startNav(plan, plan.destNode, prefs, nowMs));
      },
      // 对话用的设置：定位来源、模拟时的默认起点
      configure(m, startNode, seed) {
        mode = m === "gps" ? "gps" : "sim";
        defaultStart = startNode || null;
        simSeed = seed ?? null;
      },
      // 一句话 → 意图（本地规则）。返回意图 JSON
      understandLocal(text) {
        return J(rulesIntent(text, resort));
      },
      stripWake(text) {
        return stripWake(text);
      },
      hasWake(text) {
        return hasWake(text);
      },
      afterWake(text) {
        return afterWake(text);
      },
      // 云端“雪人”：人设系统提示 + 工具定义；工具由原生层转调 tool()
      companionPrompt() {
        return J({ system: companionSystemPrompt(resort, talkLang), tools: COMPANION_TOOLS });
      },
      tool(name, argsJson, nowMs) {
        if (nowMs != null) lastNow = nowMs;
        let args = {};
        try {
          args = JSON.parse(argsJson || "{}");
        } catch {
        }
        return J(companion.tool(name, args));
      },
      status(nowMs) {
        if (nowMs != null) lastNow = nowMs;
        return J(companion.status());
      },
      // 给云端大模型的系统提示和输出格式
      brainPrompt() {
        return J({ system: brainSystemPrompt(resort, talkLang), schema: INTENT_SCHEMA });
      },
      // 执行意图（来自云端或本地规则），返回 { say, mode, awaiting?, event? }
      converse(intentJson, nowMs) {
        lastNow = nowMs;
        let intent;
        try {
          intent = JSON.parse(intentJson);
        } catch {
          intent = { intent: "unknown" };
        }
        return J(companion.handle(intent));
      },
      companionMode() {
        return companion.mode;
      },
      simStep() {
        if (!nav || !sim) return J({ done: true });
        const fix = sim.step(1);
        if (fix) nav.onFix(fix);
        nav.tick(sim.t);
        return J({ done: nav.state === "arrived" || nav.state === "idle", simDone: sim.done, t: sim.t });
      },
      simWrongBranch() {
        return J(sim ? sim.takeWrongBranchAtNextFork() : null);
      },
      simOutage(sec) {
        if (sim) sim.startOutage(sec);
      },
      // 真实定位（CoreLocation）：速度 < 0 或误差 > 50 m 时不使用设备速度，与网页版一致
      onLocation(tMs, lat, lon, acc, speed) {
        if (!resort.proj) return;
        const { x, y } = resort.proj.toXY(lat, lon);
        const devSpeed = speed != null && !isNaN(speed) && speed >= 0 && acc <= 50 ? speed : null;
        lastNow = Math.max(lastNow, tMs);
        lastFix = { t: tMs, x, y, acc, speed: devSpeed, source: "gps" };
        if (nav && !sim) nav.onFix(lastFix);
      },
      tick(nowMs) {
        lastNow = nowMs;
        if (nav && !sim) nav.tick(nowMs);
      },
      pause(nowMs) {
        nav?.pause(sim ? sim.t : nowMs);
      },
      resume(nowMs) {
        nav?.resume(sim ? sim.t : nowMs);
      },
      stop(nowMs) {
        nav?.stop(sim ? sim.t : nowMs);
        nav = null;
        sim = null;
        companion.reset();
      },
      drainSpeech() {
        const q = queue;
        queue = [];
        return J(q);
      },
      // 重播：有距离时带上距离（与网页版的“重播”按钮一致）
      replayText(nowMs) {
        if (!nav) return J(lastSpoken?.text || null);
        const s = nav.snapshot(sim ? sim.t : nowMs);
        if (!s.nextText) return J(lastSpoken?.text || null);
        if (s.distToNext > 60 && lang !== "ja") return J(`\u7EA6${Math.round(s.distToNext / 10) * 10}\u7C73\u540E\uFF0C${s.nextText}`);
        return J(s.nextText);
      },
      snapshot(nowMs) {
        if (!nav) return J({ state: "idle", stateZh: STATE_ZH.idle });
        const s = nav.snapshot(sim ? sim.t : nowMs);
        return J({
          state: s.state,
          stateZh: s.stateZh,
          unreliable: s.unreliable,
          stationary: s.stationary,
          ambiguous: s.ambiguous,
          acc: s.acc,
          speed: s.speed,
          ageMs: s.ageMs,
          stale: s.stale,
          nextText: s.nextText,
          distToNext: s.distToNext,
          remaining: s.remaining,
          edge: s.matched?.edge ? edgeLabel(s.matched.edge) : null,
          simT: sim ? sim.t : null,
          routeKm: s.route ? s.route.reduce((a, e) => a + e.length, 0) / 1e3 : null
        });
      }
    };
  }
  return __toCommonJS(core_entry_exports);
})();
