// App 状态：“雪人”对话 → 意图（云端 Claude，失败时本地规则）→ 导航核心（JS）→ 语音回复。
// 也负责：定位（真实 GPS）、模拟器计时、轨迹记录 / 锁屏测试、唤醒词监听。

import Foundation
import CoreLocation
import Observation
import UIKit

struct ChatLine: Identifiable {
    enum Who { case user, xueren, system }
    let id = UUID()
    let who: Who
    let text: String
    var note: String? = nil
}

@MainActor
@Observable
final class NavModel {
    enum Mode: String, CaseIterable, Identifiable {
        case sim = "模拟器", gps = "真实 GPS"
        var id: String { rawValue }
    }

    // 打包进 App 的雪场（Resources 里的 json 文件名）
    let resortIds = ["demo-fictional", "kagura-osm"]

    // 设置（存在 UserDefaults）
    var resortId: String { didSet { if resortId != oldValue { save(); loadResort() } } }
    var simStartNode: String { didSet { save(); configureSession() } }
    var lang: String { didSet { save(); session?.setLang(lang) } }
    var voiceOn: Bool { didSet { save(); speech.enabled = voiceOn; if !voiceOn { speech.stop() } } }
    var wakeWordOn: Bool { didSet { save(); Task { await updateListening() } } }
    var mode: Mode { didSet { save(); configureSession(); updateLocation() } }
    var simSpeed: Double { didSet { save(); if simTimer != nil { startSimTimer() } } }
    var cloudModel: CloudModel { didSet { save(); brain.model = cloudModel } }
    var recordWhileNav: Bool { didSet { save() } }
    var dataAck = false

    // 状态
    var info: ResortInfo?
    var snapshot: NavSnapshot?
    var chat: [ChatLine] = []
    var partial = ""
    var listening = false
    var thinking = false
    var commandWindowOpen = false
    var paused = false
    var status: String?
    var selfCheck: SelfCheckResult?
    var capabilities: [String] = []
    var fatalError: String?
    var hasKey = false
    var testing = false
    var trackStats = TrackStats()
    var lastTrackFile: URL?

    var navigating: Bool { snapshot.map { $0.state != "idle" } ?? false }
    var places: [Place] { info?.places ?? [] }
    var needsAck: Bool { info?.dataStatus != "fictional" }

    private var core: NavCore?
    private var session: NavSession?
    private let speech = SpeechService()
    private let input = SpeechInput()
    private let location = LocationService()
    private let brain = CloudBrain()
    private let recorder = TrackRecorder()
    private var simTimer: Timer?
    private var tickTimer: Timer?
    private var history: [BrainTurn] = []
    private var commandWindowUntil = Date.distantPast
    private var lastStatusReport = Date()
    private var gapAnnounced = false
    private var lastNavState = "idle"

    init() {
        let d = UserDefaults.standard
        resortId = d.string(forKey: "resortId") ?? "demo-fictional"
        simStartNode = d.string(forKey: "simStartNode") ?? "S"
        lang = d.string(forKey: "lang") ?? "zh"
        voiceOn = d.object(forKey: "voiceOn") as? Bool ?? true
        wakeWordOn = d.object(forKey: "wakeWordOn") as? Bool ?? true
        mode = Mode(rawValue: d.string(forKey: "mode") ?? "") ?? .sim
        simSpeed = d.object(forKey: "simSpeed") as? Double ?? 1
        cloudModel = CloudModel(rawValue: d.string(forKey: "cloudModel") ?? "") ?? .opus
        recordWhileNav = d.object(forKey: "recordWhileNav") as? Bool ?? true

        do { core = try NavCore() } catch { fatalError = error.localizedDescription; return }
        brain.model = cloudModel
        hasKey = brain.hasKey
        location.onLocation = { [weak self] loc in self?.handle(loc) }
        location.onStatus = { [weak self] s in self?.status = s }
        speech.onSpeaking = { [weak self] on in self?.input.mute(on) }
        input.onPartial = { [weak self] t in self?.partial = t }
        input.onUtterance = { [weak self] t in self?.heard(t) }
        input.onStatus = { [weak self] s in self?.status = s; NSLog("[语音状态] %@", s) }
        NotificationCenter.default.addObserver(forName: .xueRenListen, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.talkButton() }
        }
        loadResort()
        if ProcessInfo.processInfo.arguments.contains("-selfcheck") { runSelfCheck() }
        Task { await checkCapabilities() }
        tickTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.everySecond() }
        }
        if XueRenIntentState.pendingListen { XueRenIntentState.pendingListen = false; talkButton() }
        Task { await updateListening() }
        // 测试用：启动参数 -say "一句话" 可以重复多次，启动后按顺序当作用户说的话
        let args = ProcessInfo.processInfo.arguments
        let scripted = args.indices.filter { args[$0] == "-say" && $0 + 1 < args.count }.map { args[$0 + 1] }
        if !scripted.isEmpty {
            Task {
                for line in scripted {
                    try? await Task.sleep(for: .seconds(1.5))
                    await command(session?.stripWake(line) ?? line)
                }
            }
        }
    }

    private func save() {
        let d = UserDefaults.standard
        d.set(resortId, forKey: "resortId"); d.set(simStartNode, forKey: "simStartNode"); d.set(lang, forKey: "lang")
        d.set(voiceOn, forKey: "voiceOn"); d.set(wakeWordOn, forKey: "wakeWordOn"); d.set(mode.rawValue, forKey: "mode")
        d.set(simSpeed, forKey: "simSpeed"); d.set(cloudModel.rawValue, forKey: "cloudModel"); d.set(recordWhileNav, forKey: "recordWhileNav")
    }

    func loadResort() {
        stopNav()
        guard let core else { return }
        do {
            let s = try core.session(resortId: resortId)
            session = s
            info = s.info()
            if info?.allowRealGps != true { mode = .sim }
            if !places.contains(where: { $0.node == simStartNode }) { simStartNode = places.first?.node ?? "" }
            // 神乐的雪道名是日文，中文语音读不出假名
            lang = resortId == "demo-fictional" ? "zh" : "ja"
            s.setLang(lang)
            configureSession()
            updateLocation()
            history = []
        } catch {
            status = error.localizedDescription
        }
    }

    private func configureSession() {
        session?.configure(mode: mode == .sim ? "sim" : "gps", startNode: simStartNode, seed: Int.random(in: 1...99_999))
    }

    // MARK: - 说话

    // 大按钮 / 操作按钮 / Siri：打开一个“直接说，不用喊雪人”的窗口
    func talkButton() {
        XueRenIntentState.pendingListen = false
        if speech.isSpeaking { speech.stop() }
        openCommandWindow(seconds: 8)
        Task { await updateListening() }
    }

    func setKey(_ key: String) {
        let k = key.trimmingCharacters(in: .whitespacesAndNewlines)
        if k.isEmpty { Keychain.delete() } else { Keychain.save(k) }
        hasKey = brain.hasKey
    }

    // 手动输入文字（模拟器上、或太吵时）
    func submitText(_ text: String) {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        Task { await command(session?.stripWake(t) ?? t) }
    }

    private func openCommandWindow(seconds: Double) {
        commandWindowUntil = Date().addingTimeInterval(seconds)
        commandWindowOpen = true
    }

    // 需要麦克风：开了唤醒词，或者有打开的命令窗口
    private func updateListening() async {
        let want = wakeWordOn || Date() < commandWindowUntil
        if want && !input.running {
            speech.configure(listening: true)
            await input.start(lang: lang)
            listening = input.running
        } else if !want && input.running {
            await input.stop()
            speech.configure(listening: false)
            listening = false
            partial = ""
        }
    }

    private func heard(_ text: String) {
        partial = ""
        guard let session else { return }
        let stripped = session.stripWake(text)
        let woke = session.hasWake(text)
        guard woke || Date() < commandWindowUntil else { NSLog("[唤醒] 没听到唤醒词，忽略：%@", text); return } // 没喊“雪人”的话不理会
        if stripped.isEmpty {
            reply("我在。", note: "唤醒")
            openCommandWindow(seconds: 8)
            return
        }
        commandWindowUntil = .distantPast
        commandWindowOpen = false
        Task { await command(stripped) }
    }

    private func command(_ text: String) async {
        guard let session else { return }
        chat.append(ChatLine(who: .user, text: text))
        configureSession()
        var intent: String?
        var via = "离线规则"
        if brain.hasKey, let p = session.brainPrompt() {
            thinking = true
            intent = await brain.interpret(text: text, context: contextLine(), history: history, system: p.system, schema: p.schema)
            thinking = false
            if intent != nil { via = "云端 \(cloudModel == .opus ? "Opus" : "Haiku")" }
        }
        let intentJSON = intent ?? session.understandLocal(text)
        NSLog("[雪人] %@ → %@（%@）", text, intentJSON, via)
        let r = session.converse(intentJSON: intentJSON, nowMs: nowMs)
        history.append(BrainTurn(role: "user", text: text))
        if !r.say.isEmpty { history.append(BrainTurn(role: "assistant", text: r.say)) }
        if history.count > 12 { history.removeFirst(history.count - 12) }

        switch r.event {
        case "started": navStarted()
        case "stopped": navStopped()
        case "paused": paused = true; speech.stop()
        case "resumed": paused = false
        default: break
        }
        flushSpeech()
        if !r.say.isEmpty { reply(r.say, note: via) }
        // 对话中：回复后一小段时间内不用再喊雪人，可以直接接着说（问了“要出发吗？”时更长）
        let speakSec = Double(r.say.count) / 4
        openCommandWindow(seconds: (r.awaiting == true ? 12 : 8) + speakSec)
        await updateListening()
        refresh()
    }

    private func contextLine() -> String {
        let s = snapshot
        var parts = ["雪场：\(info?.name ?? "")", "定位来源：\(mode.rawValue)"]
        if navigating {
            parts.append("正在导航（\(s?.stateZh ?? "")）")
            if let n = s?.nextText { parts.append("下一条提示：\(n)") }
        } else {
            parts.append("未在导航")
        }
        if let last = history.last, last.role == "assistant", last.text.hasSuffix("？") || last.text.hasSuffix("?") {
            parts.append("雪人刚问：\(last.text)")
        }
        return parts.joined(separator: "；")
    }

    private func reply(_ text: String, note: String? = nil) {
        chat.append(ChatLine(who: .xueren, text: text, note: note))
        speech.speak(text, lang: lang)
    }

    // MARK: - 导航

    private func navStarted() {
        paused = false
        if mode == .sim {
            startSimTimer()
        } else {
            location.start()
            if recordWhileNav && !recorder.recording { recorder.start() }
        }
    }

    private func navStopped() {
        simTimer?.invalidate(); simTimer = nil
        paused = false
        if recorder.recording && !testing { finishRecording() }
        updateLocation()
    }

    func stopNav() {
        simTimer?.invalidate(); simTimer = nil
        if navigating { session?.stop(nowMs: nowMs) }
        if recorder.recording && !testing { finishRecording() }
        paused = false
        speech.stop()
        refresh()
    }

    func togglePause() {
        guard let session, navigating else { return }
        if paused { session.resume(nowMs: nowMs); paused = false } else { session.pause(nowMs: nowMs); paused = true; speech.stop() }
        refresh()
    }

    func replay() {
        guard let text = session?.replayText(nowMs: nowMs) else { return }
        speech.speak(text, lang: lang)
    }

    func simWrongBranch() { session?.simWrongBranch() }
    func simOutage() { session?.simOutage(seconds: 12) }

    // 真实 GPS 模式下一直定位（规划时要知道“从这里出发”）；模拟模式且没在测试时关掉
    private func updateLocation() {
        if mode == .gps && info?.allowRealGps == true || testing {
            if !location.running { location.start() }
        } else if location.running && !recorder.recording {
            location.stop()
        }
    }

    // MARK: - 锁屏测试 / 轨迹记录

    func startTest() {
        testing = true
        recorder.start()
        location.start()
        lastStatusReport = Date()
        gapAnnounced = false
        reply("开始锁屏测试。可以锁屏、放进口袋、放音乐。每五分钟报告一次定位情况，定位中断时会提醒。")
        Task { await updateListening() }
    }

    func stopTest() {
        testing = false
        finishRecording()
        let s = trackStats
        var msg = "测试结束：\(Int(s.durationSec / 60)) 分钟，\(s.points) 个定位点，最长中断 \(Int(s.maxGapSec)) 秒。"
        if let a = s.batteryStart, let b = s.batteryNow { msg += "电量 \(Int(a * 100))% → \(Int(b * 100))%。" }
        reply(msg)
        updateLocation()
    }

    private func finishRecording() {
        lastTrackFile = recorder.stop()
        trackStats = recorder.stats
    }

    // MARK: - 定时

    private var nowMs: Double { Date().timeIntervalSince1970 * 1000 }

    private func startSimTimer() {
        simTimer?.invalidate()
        simTimer = Timer.scheduledTimer(withTimeInterval: 1 / simSpeed, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.simTick() }
        }
    }

    private func simTick() {
        guard let session, !paused else { return }
        let r = session.simStep()
        flushSpeech()
        refresh()
        if r?.done == true { simTimer?.invalidate(); simTimer = nil }
    }

    // 前台和后台（定位在跑时 App 不会被挂起）都会走这里
    private func everySecond() {
        if commandWindowOpen && Date() >= commandWindowUntil {
            commandWindowOpen = false
            Task { await updateListening() }
        }
        if mode == .gps && navigating { session?.tick(nowMs: nowMs); flushSpeech() }
        if recorder.recording { trackStats = recorder.stats }
        if testing { testTick() }
        refresh()
    }

    private func testTick() {
        if let gap = recorder.secondsSinceLastFix(), gap > 10 {
            if !gapAnnounced { gapAnnounced = true; reply("定位中断，已经 \(Int(gap)) 秒没有新位置。") }
        }
        if Date().timeIntervalSince(lastStatusReport) >= 300 {
            lastStatusReport = Date()
            let s = recorder.stats
            var msg = "定位正常，已记录 \(s.points) 个点，最长中断 \(Int(s.maxGapSec)) 秒"
            if let b = s.batteryNow { msg += "，电量 \(Int(b * 100))%" }
            reply(msg + "。")
        }
    }

    private func handle(_ loc: CLLocation) {
        if recorder.recording {
            if gapAnnounced, let gap = recorder.secondsSinceLastFix() {
                gapAnnounced = false
                reply("定位恢复，中断了 \(Int(gap)) 秒。")
            }
            recorder.add(loc)
        }
        guard let session, mode == .gps else { return }
        let speed: Double? = loc.speed >= 0 ? loc.speed : nil
        session.onLocation(tMs: loc.timestamp.timeIntervalSince1970 * 1000,
                           lat: loc.coordinate.latitude, lon: loc.coordinate.longitude,
                           acc: loc.horizontalAccuracy, speed: speed)
        if navigating {
            session.tick(nowMs: nowMs)   // 后台没有定时器时，靠定位回调发现中断
            flushSpeech()
        }
        refresh()
    }

    private func flushSpeech() {
        guard let session else { return }
        for item in session.drainSpeech() {
            chat.append(ChatLine(who: .system, text: item.text, note: item.reason))
            NSLog("[播报] %@", item.text)
            if item.voice && !paused { speech.speak(item.text, lang: lang) }
        }
        if chat.count > 200 { chat.removeFirst(chat.count - 200) }
    }

    private func refresh() {
        snapshot = session?.snapshot(nowMs: nowMs)
        let st = snapshot?.state ?? "idle"
        if st != lastNavState {
            if st == "arrived" && mode == .gps && recorder.recording && !testing { finishRecording() }
            lastNavState = st
        }
    }

    // MARK: - 开发

    func runSelfCheck() {
        guard let core else { return }
        let r = core.runSelfCheck()
        selfCheck = r
        NSLog("[自检] %@", r.message)
        for (i, t) in r.actual.enumerated() { NSLog("[自检] %02d %@", i + 1, t) }
    }

    func checkCapabilities() async {
        capabilities = await DeviceCapabilities.report()
        for line in capabilities { NSLog("[能力] %@", line) }
    }
}
