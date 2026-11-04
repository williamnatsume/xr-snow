// App 状态：雪场 / 起终点 / 偏好 → 规划 → 导航（模拟器或真实 GPS），把定位喂给导航核心、把播报交给语音。

import Foundation
import CoreLocation
import Observation

struct SpokenLine: Identifiable {
    let id = UUID()
    let time: String
    let text: String
    let reason: String?
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

    var resortId = "demo-fictional" { didSet { if resortId != oldValue { loadResort() } } }
    var info: ResortInfo?
    var startNode = ""
    var goalNode = ""
    var maxDifficulty = 2
    var avoidFlat = false
    var preferShort = false
    var lang = "zh" { didSet { session?.setLang(lang) } }
    var voiceOn = true { didSet { speech.enabled = voiceOn; if !voiceOn { speech.stop() } } }
    var mode: Mode = .sim
    var simSpeed = 1.0 { didSet { if simTimer != nil { startSimTimer() } } }
    var dataAck = false

    var plan: PlanResult?
    var snapshot: NavSnapshot?
    var navigating = false
    var paused = false
    var spoken: [SpokenLine] = []
    var status: String?
    var selfCheck: SelfCheckResult?
    var fatalError: String?
    var capabilities: [String] = []

    private var core: NavCore?
    private var session: NavSession?
    private let speech = SpeechService()
    private let location = LocationService()
    private var simTimer: Timer?
    private var tickTimer: Timer?

    init() {
        do { core = try NavCore() } catch { fatalError = error.localizedDescription; return }
        location.onLocation = { [weak self] loc in self?.handle(loc) }
        location.onStatus = { [weak self] s in self?.status = s }
        loadResort()
        if ProcessInfo.processInfo.arguments.contains("-selfcheck") { runSelfCheck() }
        Task { await checkCapabilities() }
    }

    var places: [Place] { info?.places ?? [] }
    var needsAck: Bool { info?.dataStatus != "fictional" }

    func loadResort() {
        stop()
        plan = nil
        guard let core else { return }
        do {
            let s = try core.session(resortId: resortId)
            s.setLang(lang)
            session = s
            info = s.info()
            let p = places
            startNode = p.first?.node ?? ""
            goalNode = p.count > 1 ? p[p.count - 1].node : startNode
            // 神乐的雪道名是日文，中文语音读不出假名
            lang = resortId == "demo-fictional" ? "zh" : "ja"
            if info?.allowRealGps != true { mode = .sim }
        } catch {
            status = error.localizedDescription
        }
    }

    func doPlan() {
        guard let session else { return }
        let prefs = "{\"maxDifficulty\":\(maxDifficulty),\"avoidFlat\":\(avoidFlat),\"preferShort\":\(preferShort)}"
        plan = session.plan(start: startNode, goal: goalNode, prefsJSON: prefs)
    }

    func start() {
        guard let session else { return }
        if plan?.ok != true { doPlan() }
        guard plan?.ok == true else { status = "请先规划出一条可用路线"; return }
        if mode == .gps {
            guard info?.allowRealGps == true else { status = "这个地图不允许真实 GPS 导航"; return }
            guard dataAck else { status = "请先确认“地图数据未核实”"; return }
        }
        stop()
        spoken = []
        let r = session.start(mode: mode == .sim ? "sim" : "gps", nowMs: nowMs, seed: Int.random(in: 1...99_999))
        guard r.ok else { status = r.reason; return }
        navigating = true
        paused = false
        status = nil
        if mode == .sim {
            startSimTimer()
        } else {
            location.start()
            tickTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated { self?.foregroundTick() }
            }
        }
        flushSpeech()
        refresh()
    }

    func togglePause() {
        guard let session, navigating else { return }
        if paused { session.resume(nowMs: nowMs); paused = false }
        else { session.pause(nowMs: nowMs); paused = true; speech.stop() }
        refresh()
    }

    func stop() {
        simTimer?.invalidate(); simTimer = nil
        tickTimer?.invalidate(); tickTimer = nil
        if location.running { location.stop() }
        if navigating { session?.stop(nowMs: nowMs) }
        navigating = false
        paused = false
        speech.stop()
        refresh()
    }

    func replay() {
        guard let text = session?.replayText(nowMs: nowMs) else { return }
        speech.speak(text, lang: lang)
    }

    func simWrongBranch() { session?.simWrongBranch() }
    func simOutage() { session?.simOutage(seconds: 12) }

    func checkCapabilities() async {
        capabilities = await DeviceCapabilities.report()
        for line in capabilities { NSLog("[能力] %@", line) }
    }

    func runSelfCheck() {
        guard let core else { return }
        let r = core.runSelfCheck()
        selfCheck = r
        NSLog("[自检] %@", r.message)
        for (i, t) in r.actual.enumerated() { NSLog("[自检] %02d %@", i + 1, t) }
    }

    // MARK: - 内部

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

    private func foregroundTick() {
        session?.tick(nowMs: nowMs)
        flushSpeech()
        refresh()
    }

    // 后台时没有定时器：每次定位回调里顺便 tick，用于发现定位中断
    private func handle(_ loc: CLLocation) {
        guard let session, navigating, mode == .gps else { return }
        let speed: Double? = loc.speed >= 0 ? loc.speed : nil
        session.onLocation(tMs: loc.timestamp.timeIntervalSince1970 * 1000,
                           lat: loc.coordinate.latitude, lon: loc.coordinate.longitude,
                           acc: loc.horizontalAccuracy, speed: speed)
        session.tick(nowMs: nowMs)
        flushSpeech()
        refresh()
    }

    private func flushSpeech() {
        guard let session else { return }
        let f = DateFormatter()
        f.dateFormat = "HH:mm:ss"
        for item in session.drainSpeech() {
            let time: String
            if mode == .sim, let t = item.t { time = String(format: "%d:%02d", Int(t / 1000) / 60, Int(t / 1000) % 60) }
            else { time = f.string(from: Date()) }
            spoken.insert(SpokenLine(time: time, text: item.text, reason: item.reason), at: 0)
            if spoken.count > 100 { spoken.removeLast() }
            NSLog("[播报] %@ %@", time, item.text)
            if item.voice && !paused { speech.speak(item.text, lang: lang) }
        }
    }

    private func refresh() {
        snapshot = session?.snapshot(nowMs: nowMs)
    }
}
