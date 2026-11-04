// 导航核心桥接：在 JavaScriptCore 里运行 navcore.js（由 nav/ 打包，npm run build:ios），
// 原生层只负责定位、语音和界面，所有导航判断都在 JS 里完成，与网页版、npm test 同一份逻辑。
// 所有调用都在主线程。

import Foundation
import JavaScriptCore

struct Place: Decodable, Identifiable, Hashable {
    let node: String
    let name: String
    let nameJa: String?
    var id: String { node }
}

struct ResortInfo: Decodable {
    let errors: [String]
    let warnings: [String]
    let id: String?
    let name: String?
    let dataStatus: String?
    let allowRealGps: Bool
    let disclaimer: String
    let places: [Place]
}

struct PlanStep: Decodable, Identifiable {
    let id: String
    let type: String
    let label: String
    let length: Double
    let difficulty: Int?
}

struct PlanResult: Decodable {
    let ok: Bool
    let reason: String?
    let hints: [String]?
    let warnings: [String]?
    let length: Double?
    let time: Double?
    let maxDiffZh: String?
    let steps: [PlanStep]?
    let maneuvers: [String]?
}

struct SpeechItem: Decodable {
    let text: String
    let reason: String?
    let voice: Bool
    let key: String
    let t: Double?
}

struct NavSnapshot: Decodable {
    let state: String
    let stateZh: String?
    let unreliable: String?
    let acc: Double?
    let speed: Double?
    let stale: Bool?
    let nextText: String?
    let distToNext: Double?
    let remaining: Double?
    let edge: String?
    let simT: Double?
}

struct ConverseResult: Decodable {
    let say: String
    let mode: String
    let awaiting: Bool?
    let event: String?
}

struct SimStepResult: Decodable {
    let done: Bool
    let simDone: Bool?
}

struct SelfCheckResult {
    let passed: Bool
    let expected: [String]
    let actual: [String]
    let message: String
}

enum NavCoreError: Error, LocalizedError {
    case missingResource(String)
    case js(String)
    var errorDescription: String? {
        switch self {
        case .missingResource(let n): return "缺少资源文件：\(n)（请运行 npm run build:ios）"
        case .js(let m): return "导航核心出错：\(m)"
        }
    }
}

final class NavCore {
    private let context: JSContext
    private let xrnav: JSValue
    private(set) var lastError: String?

    init() throws {
        guard let url = Bundle.main.url(forResource: "navcore", withExtension: "js"),
              let source = try? String(contentsOf: url, encoding: .utf8) else {
            throw NavCoreError.missingResource("navcore.js")
        }
        guard let ctx = JSContext() else { throw NavCoreError.js("无法创建 JSContext") }
        ctx.name = "XRNav"
        var jsError: String?
        ctx.exceptionHandler = { _, exc in
            jsError = exc?.toString()
            NSLog("[NavCore] JS 异常：%@", exc?.toString() ?? "?")
        }
        ctx.evaluateScript(source, withSourceURL: url)
        if let e = jsError { throw NavCoreError.js(e) }
        guard let x = ctx.objectForKeyedSubscript("XRNav"), !x.isUndefined else { throw NavCoreError.js("找不到全局对象 XRNav") }
        context = ctx
        xrnav = x
        ctx.exceptionHandler = { [weak self] _, exc in
            self?.lastError = exc?.toString()
            NSLog("[NavCore] JS 异常：%@", exc?.toString() ?? "?")
        }
    }

    static func resortText(_ id: String) throws -> String {
        guard let url = Bundle.main.url(forResource: id, withExtension: "json"),
              let text = try? String(contentsOf: url, encoding: .utf8) else {
            throw NavCoreError.missingResource("\(id).json")
        }
        return text
    }

    func session(resortId: String) throws -> NavSession {
        let text = try NavCore.resortText(resortId)
        guard let s = xrnav.invokeMethod("createSession", withArguments: [text]), s.isObject else {
            throw NavCoreError.js(lastError ?? "createSession 失败")
        }
        return NavSession(value: s)
    }

    // M1 验收：按与 tests/core-bundle.test.mjs 相同的调用顺序，在 JSC 里逐秒跑模拟，
    // 对比 npm run build:ios 生成的期望播报序列。
    func runSelfCheck() -> SelfCheckResult {
        struct Expected: Decodable {
            struct Scenario: Decodable {
                struct Sim: Decodable { let seed: Int }
                let start: String
                let goal: String
                let prefs: [String: Int]
                let sim: Sim
            }
            let resort: String
            let scenario: Scenario
            let texts: [String]
        }
        do {
            guard let url = Bundle.main.url(forResource: "selfcheck-expected", withExtension: "json") else {
                throw NavCoreError.missingResource("selfcheck-expected.json")
            }
            let exp = try JSONDecoder().decode(Expected.self, from: Data(contentsOf: url))
            let s = try session(resortId: exp.resort)
            let prefs = String(data: try JSONSerialization.data(withJSONObject: exp.scenario.prefs), encoding: .utf8) ?? "{}"
            guard s.plan(start: exp.scenario.start, goal: exp.scenario.goal, prefsJSON: prefs).ok else {
                throw NavCoreError.js("自检场景无法规划")
            }
            _ = s.start(mode: "sim", nowMs: 0, seed: exp.scenario.sim.seed)
            var texts = s.drainSpeech().map(\.text)
            var doneAt: Int?
            for sec in 1...3000 {
                let snap = s.snapshot(nowMs: 0)
                if snap?.state == "arrived" || (doneAt != nil && sec - doneAt! > 30) {
                    for _ in 0..<10 { _ = s.simStep(); texts += s.drainSpeech().map(\.text) }
                    break
                }
                let r = s.simStep()
                if r?.simDone == true && doneAt == nil { doneAt = sec }
                texts += s.drainSpeech().map(\.text)
            }
            let arrived = s.snapshot(nowMs: 0)?.state == "arrived"
            let same = texts == exp.texts
            let msg = same && arrived
                ? "自检通过：\(texts.count) 条播报与 npm test 场景一致，已到达"
                : "自检失败：期望 \(exp.texts.count) 条，实际 \(texts.count) 条\(arrived ? "" : "，未到达")"
            return SelfCheckResult(passed: same && arrived, expected: exp.texts, actual: texts, message: msg)
        } catch {
            return SelfCheckResult(passed: false, expected: [], actual: [], message: "自检失败：\(error.localizedDescription)")
        }
    }
}

// 对应 nav/core-entry.js 的 createSession()
final class NavSession {
    private let value: JSValue
    init(value: JSValue) { self.value = value }

    private func call(_ name: String, _ args: [Any] = []) -> String? {
        guard let r = value.invokeMethod(name, withArguments: args), r.isString else { return nil }
        return r.toString()
    }

    private func decode<T: Decodable>(_ type: T.Type, _ json: String?) -> T? {
        guard let json, let data = json.data(using: .utf8) else { return nil }
        do { return try JSONDecoder().decode(T.self, from: data) } catch {
            NSLog("[NavCore] 解析 %@ 失败：%@", String(describing: T.self), String(describing: error))
            return nil
        }
    }

    func info() -> ResortInfo? { decode(ResortInfo.self, call("info")) }
    func setLang(_ lang: String) { value.invokeMethod("setLang", withArguments: [lang]) }

    func plan(start: String, goal: String, prefsJSON: String) -> PlanResult {
        decode(PlanResult.self, call("plan", [start, goal, prefsJSON]))
            ?? PlanResult(ok: false, reason: "导航核心出错", hints: nil, warnings: nil, length: nil, time: nil, maxDiffZh: nil, steps: nil, maneuvers: nil)
    }

    struct StartResult: Decodable { let ok: Bool; let reason: String? }
    func start(mode: String, nowMs: Double, seed: Int? = nil) -> StartResult {
        var args: [Any] = [mode, nowMs]
        if let seed { args.append(seed) }
        return decode(StartResult.self, call("start", args)) ?? StartResult(ok: false, reason: "导航核心出错")
    }

    func simStep() -> SimStepResult? { decode(SimStepResult.self, call("simStep")) }
    func simWrongBranch() { _ = call("simWrongBranch") }
    func simOutage(seconds: Double) { value.invokeMethod("simOutage", withArguments: [seconds]) }

    func onLocation(tMs: Double, lat: Double, lon: Double, acc: Double, speed: Double?) {
        value.invokeMethod("onLocation", withArguments: [tMs, lat, lon, acc, speed ?? NSNull()])
    }

    func tick(nowMs: Double) { value.invokeMethod("tick", withArguments: [nowMs]) }
    func pause(nowMs: Double) { value.invokeMethod("pause", withArguments: [nowMs]) }
    func resume(nowMs: Double) { value.invokeMethod("resume", withArguments: [nowMs]) }
    func stop(nowMs: Double) { value.invokeMethod("stop", withArguments: [nowMs]) }

    // 对话（nav/companion.js）
    func configure(mode: String, startNode: String?, seed: Int) {
        value.invokeMethod("configure", withArguments: [mode, startNode ?? NSNull(), seed])
    }
    func understandLocal(_ text: String) -> String { call("understandLocal", [text]) ?? "{\"intent\":\"unknown\"}" }
    func stripWake(_ text: String) -> String { call("stripWake", [text]) ?? text }
    func hasWake(_ text: String) -> Bool { value.invokeMethod("hasWake", withArguments: [text])?.toBool() ?? false }
    func converse(intentJSON: String, nowMs: Double) -> ConverseResult {
        decode(ConverseResult.self, call("converse", [intentJSON, nowMs])) ?? ConverseResult(say: "导航核心出错", mode: "idle", awaiting: nil, event: nil)
    }
    // 云端大模型的系统提示和输出格式
    func brainPrompt() -> (system: String, schema: Any)? {
        guard let json = call("brainPrompt"), let d = json.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
              let sys = obj["system"] as? String, let schema = obj["schema"] else { return nil }
        return (sys, schema)
    }

    func drainSpeech() -> [SpeechItem] { decode([SpeechItem].self, call("drainSpeech")) ?? [] }
    func replayText(nowMs: Double) -> String? { decode(String?.self, call("replayText", [nowMs])) ?? nil }
    func snapshot(nowMs: Double) -> NavSnapshot? { decode(NavSnapshot.self, call("snapshot", [nowMs])) }
}
