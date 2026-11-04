// 语音输入：iOS 26 的 SpeechAnalyzer + SpeechTranscriber，本机离线识别。
// 两种语言的识别器同时听同一路麦克风（iOS 最多允许 2 个），每句话取“置信度”最高的那种语言的结果。
// 默认中文 + 日语，第二语言可在设置里换成英语。
// 一句话的结束：停顿 0.6 秒（命令已完整）或 1.4 秒；喊了“雪人”之后最多再听 7 秒。
// 播报语音时静音输入，且静音有最长时限（防止播报结束回调没来时一直听不见）。
// 音频被打断（来电、Siri、系统语音会话等）或 2 秒收不到声音时自动重启麦克风。
// 麦克风用 iPhone 自带的（不用 AirPods 通话麦克风，否则蓝牙音乐会变成通话音质）。

import Foundation
import AVFoundation
import Speech

@MainActor
final class SpeechInput {
    var onUtterance: ((String, String) -> Void)?    // (文字, 语言 zh/ja/en)
    var onPartial: ((String) -> Void)?
    var onStatus: ((String) -> Void)?
    // 这句话是否已经是完整的命令（能马上处理）
    var isComplete: ((String) -> Bool)?
    // 这段文字值不值得留着（喊过雪人 / 正在等命令）。不值得的说完就丢，免得旁边的人声把命令淹没
    var shouldKeep: ((String) -> Bool)?
    private(set) var running = false
    private(set) var langs: [String] = []

    private final class Lane {
        let lang: String
        let analyzer: SpeechAnalyzer
        let builder: AsyncStream<AnalyzerInput>.Continuation
        var task: Task<Void, Never>?
        var finalized = ""
        var volatile = ""
        var confSum = 0.0
        var confCount = 0
        init(lang: String, analyzer: SpeechAnalyzer, builder: AsyncStream<AnalyzerInput>.Continuation) {
            self.lang = lang; self.analyzer = analyzer; self.builder = builder
        }
        var text: String { (finalized + volatile).trimmingCharacters(in: .whitespacesAndNewlines) }
        var confidence: Double { confCount > 0 ? confSum / Double(confCount) : 0 }
        func reset() { finalized = ""; volatile = ""; confSum = 0; confCount = 0 }
    }

    private let engine = AVAudioEngine()
    private var lanes: [Lane] = []
    private var analyzerFormat: AVAudioFormat?
    private var tapInstalled = false
    private var lastChange = Date()
    private var mutedUntil = Date.distantPast
    private var silenceTimer: Timer?
    private var commandStart: Date?
    private let audioClock = AudioClock()
    private var observers: [NSObjectProtocol] = []

    static func requestMicPermission() async -> Bool {
        await AVAudioApplication.requestRecordPermission()
    }

    // 刚听到“雪人”：从这里开始最多再听 7 秒（旁边一直有人说话时也能结束）
    func markCommandStart() { commandStart = Date() }

    func start(langs wanted: [String]) async {
        guard !running else { return }
        #if targetEnvironment(simulator)
        // 模拟器的麦克风输入会让音频系统超时崩溃（实测），模拟器上只用打字
        onStatus?("模拟器上不支持语音输入，请用键盘打字")
        #else
        await startListening(langs: wanted)
        #endif
    }

    private static func locale(_ lang: String) -> Locale {
        Locale(identifier: lang == "ja" ? "ja-JP" : lang == "en" ? "en-US" : "zh-CN")
    }

    private func startListening(langs wanted: [String]) async {
        guard await Self.requestMicPermission() else { onStatus?("没有麦克风权限：请在 设置 → 雪人 中允许麦克风"); return }
        do {
            var transcribers: [(String, SpeechTranscriber)] = []
            for lang in wanted {
                let t = SpeechTranscriber(locale: Self.locale(lang), transcriptionOptions: [],
                                          reportingOptions: [.volatileResults, .fastResults],
                                          attributeOptions: [.transcriptionConfidence])
                if let req = try await AssetInventory.assetInstallationRequest(supporting: [t]) {
                    onStatus?("正在下载\(lang)语音识别模型…")
                    do { try await req.downloadAndInstall() } catch {
                        NSLog("[语音] %@ 模型下载失败，先不用：%@", lang, error.localizedDescription)
                        continue
                    }
                }
                transcribers.append((lang, t))
            }
            guard !transcribers.isEmpty else { onStatus?("没有可用的语音识别模型"); return }
            let fmt = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: transcribers.map { $0.1 })
            analyzerFormat = fmt

            // 每种语言一个 SpeechAnalyzer。iOS 限制同时最多 2 个识别器（真机实测：第 3 个报
            // “Maximum number of recognizers reached”，放进同一个 analyzer 也一样），所以最多两种语言。
            lanes = []
            for (lang, t) in transcribers.prefix(2) {
                let a = SpeechAnalyzer(modules: [t])
                let (stream, builder) = AsyncStream<AnalyzerInput>.makeStream()
                let lane = Lane(lang: lang, analyzer: a, builder: builder)
                lane.task = Task { [weak self, weak lane] in
                    do {
                        for try await r in t.results {
                            let text = String(r.text.characters)
                            var sum = 0.0, n = 0
                            for run in r.text.runs {
                                if let c = run[AttributeScopes.SpeechAttributes.ConfidenceAttribute.self] { sum += c; n += 1 }
                            }
                            let isFinal = r.isFinal
                            await MainActor.run {
                                guard let self, let lane else { return }
                                self.handle(lane: lane, text: text, isFinal: isFinal, conf: n > 0 ? sum / Double(n) : nil)
                            }
                        }
                    } catch {
                        NSLog("[语音] %@ 识别结束：%@", lang, error.localizedDescription)
                        await MainActor.run { self?.laneDied(lang) }
                    }
                }
                try await a.start(inputSequence: stream)
                lanes.append(lane)
            }
            langs = lanes.map(\.lang)
            try startEngine()
            observeAudioSession()
            running = true
            silenceTimer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated { self?.tick() }
            }
            NSLog("[语音] 开始听：%@，输入格式 %@", langs.joined(separator: "+"), String(describing: analyzerFormat))
            onStatus?("正在听（\(langs.joined(separator: "/"))）")
        } catch {
            NSLog("[语音] 启动失败：%@", String(describing: error))
            onStatus?("语音识别启动失败：\(error.localizedDescription)")
            await stop()
        }
    }

    func stop() async {
        silenceTimer?.invalidate(); silenceTimer = nil
        for o in observers { NotificationCenter.default.removeObserver(o) }
        observers = []
        // 只在装过 tap 时才碰 inputNode：没启动成功时访问它会让音频系统超时崩溃（模拟器上实测）
        if tapInstalled { engine.inputNode.removeTap(onBus: 0); tapInstalled = false }
        if engine.isRunning { engine.stop() }
        for l in lanes {
            l.builder.finish()
            try? await l.analyzer.finalizeAndFinishThroughEndOfInput()
            l.task?.cancel()
        }
        lanes = []
        running = false
    }

    // 播报时静音输入（最多 seconds 秒，防止播报结束的回调没来时一直听不见）；恢复时丢掉期间的结果
    func mute(_ on: Bool, seconds: Double = 8) {
        mutedUntil = on ? Date().addingTimeInterval(seconds) : Date().addingTimeInterval(0.35)
        for l in lanes { l.reset() }
        NSLog("[语音] %@", on ? "播报中，暂停收音" : "播报结束，恢复收音")
    }

    private func startEngine() throws {
        let input = engine.inputNode
        let inFormat = input.outputFormat(forBus: 0)
        guard let outFormat = analyzerFormat, let conv = AVAudioConverter(from: inFormat, to: outFormat) else { return }
        let builders = lanes.map(\.builder)
        let clock = audioClock
        // 在音频线程里转换一次格式，再送给每个语言的识别器（不碰主线程状态）
        input.installTap(onBus: 0, bufferSize: 2048, format: inFormat) { buffer, _ in
            clock.tick()
            SpeechInput.convert(buffer, with: conv, to: outFormat, into: builders)
        }
        tapInstalled = true
        engine.prepare()
        try engine.start()
    }

    private func restartEngine(_ why: String) {
        guard running else { return }
        NSLog("[语音] 重启麦克风：%@", why)
        audioClock.tick()
        if tapInstalled { engine.inputNode.removeTap(onBus: 0); tapInstalled = false }
        if engine.isRunning { engine.stop() }
        do {
            try AVAudioSession.sharedInstance().setActive(true)
            try startEngine()
        } catch {
            NSLog("[语音] 重启失败：%@", error.localizedDescription)
        }
    }

    private func observeAudioSession() {
        let nc = NotificationCenter.default
        observers.append(nc.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] n in
            let raw = n.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
            MainActor.assumeIsolated {
                NSLog("[语音] 音频打断：%@", raw == 1 ? "开始" : "结束")
                if raw == 0 { self?.restartEngine("音频打断结束") }
            }
        })
        observers.append(nc.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.restartEngine("音频配置变化") }
        })
    }

    nonisolated private static func convert(_ buffer: AVAudioPCMBuffer, with converter: AVAudioConverter, to outFormat: AVAudioFormat,
                                            into builders: [AsyncStream<AnalyzerInput>.Continuation]) {
        let ratio = outFormat.sampleRate / buffer.format.sampleRate
        let cap = AVAudioFrameCount(Double(buffer.frameLength) * ratio + 1024)
        guard let out = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: cap) else { return }
        var consumed = false
        var err: NSError?
        converter.convert(to: out, error: &err) { _, status in
            if consumed { status.pointee = .noDataNow; return nil }
            consumed = true
            status.pointee = .haveData
            return buffer
        }
        guard err == nil && out.frameLength > 0 else { return }
        for b in builders { b.yield(AnalyzerInput(buffer: out)) }
    }

    private func handle(lane: Lane, text: String, isFinal: Bool, conf: Double?) {
        if Date() < mutedUntil { return }
        if let conf { lane.confSum += conf; lane.confCount += 1 }
        if isFinal {
            let keep = shouldKeep?(lane.finalized + text) ?? true
            lane.finalized = keep ? lane.finalized + text : ""
            lane.volatile = ""
            if !keep { lane.confSum = 0; lane.confCount = 0 }
        } else {
            lane.volatile = text
        }
        lastChange = Date()
        // 唤醒词在哪个语言里出现都算：优先把含唤醒词的那条交给上层
        let texts = lanes.map(\.text).filter { !$0.isEmpty }
        if let withWake = texts.first(where: { shouldKeep?($0) ?? false }) { onPartial?(withWake) }
        else if let b = best() { onPartial?(b.text) }
    }

    // 某个语言的识别器被系统停掉：从候选里去掉，其余继续
    private func laneDied(_ lang: String) {
        lanes.removeAll { $0.lang == lang }
        langs = lanes.map(\.lang)
        onStatus?("正在听（\(langs.joined(separator: "/"))）")
    }

    // 置信度最高的语言（还没有置信度时用文字长度兜底）
    private func best() -> Lane? {
        let cands = lanes.filter { !$0.text.isEmpty }
        return cands.max { a, b in
            if a.confCount > 0 && b.confCount > 0 { return a.confidence < b.confidence }
            return a.text.count < b.text.count
        }
    }

    private func tick() {
        // 2 秒没收到任何音频：麦克风被系统停了，重启
        if running, audioClock.secondsSinceLast() > 2 { restartEngine("2 秒没有音频") }
        guard let b = best() else { return }
        let quiet = Date().timeIntervalSince(lastChange)
        let complete = lanes.contains { !$0.text.isEmpty && (isComplete?($0.text) ?? false) }
        let need = complete ? 0.6 : 1.4
        let tooLong = commandStart.map { Date().timeIntervalSince($0) > 7 } ?? false
        guard quiet > need || tooLong else { return }
        // 唤醒词 / 命令可能只在某种语言的结果里：优先用“值得保留”的那条里置信度最高的
        let pick = lanes.filter { !$0.text.isEmpty && (shouldKeep?($0.text) ?? false) }
            .max { $0.confidence < $1.confidence } ?? b
        let keep = shouldKeep?(pick.text) ?? true
        let summary = lanes.map { "\($0.lang)=\($0.text)(\(String(format: "%.2f", $0.confidence)))" }.joined(separator: " | ")
        let text = pick.text, lang = pick.lang
        for l in lanes { l.reset() }
        commandStart = nil
        guard keep else { return }   // 旁边的人声：不交给上层
        NSLog("[语音] 一句话（停顿 %.1f 秒%@），选 %@：%@  [%@]", quiet, tooLong ? "，超过 7 秒强制结束" : "", lang, text, summary)
        onUtterance?(text, lang)
    }
}

// 音频线程记录“最后一次收到声音”的时间（主线程读）
final class AudioClock: @unchecked Sendable {
    private var last = Date()
    private let lock = NSLock()
    func tick() { lock.lock(); last = Date(); lock.unlock() }
    func secondsSinceLast() -> Double { lock.lock(); defer { lock.unlock() }; return Date().timeIntervalSince(last) }
}
