// 语音对话的音频管线（听 + 说），按专业语音助手的做法：
//
// 1. 回声消除：麦克风开启 iOS 语音处理（AEC + 降噪 + 自动增益，和通话 / FaceTime 同一套），
//    雪人的声音也从同一个 AVAudioEngine 播出，系统知道自己放了什么，会从麦克风里减掉 →
//    雪人不会把自己的话当成用户说的；用户可以在她说话时插话（喊“雪人”会打断她）。
// 2. 按音频时间切句：每个识别出的词都带音频时间。一句话交给上层后，记下它结束的时间，
//    之后识别器重发的、时间更早的词一律丢掉 → 不会重复。
// 3. 两种语言同时识别（iOS 最多 2 个识别器），每句话取置信度最高的。
// 4. 一句话的结束：停顿 0.6 秒（命令已完整）或 1.4 秒；喊了“雪人”之后最多再听 7 秒。
// 5. 音频被打断 / 配置变化 / 2 秒没声音 → 自动重启麦克风。
// 麦克风用 iPhone 自带的（不用 AirPods 通话麦克风，否则蓝牙音乐会变成通话音质）。

import Foundation
import AVFoundation
import CoreMedia
import Speech

@MainActor
final class SpeechInput: NSObject {
    var onUtterance: ((String, String) -> Void)?    // (文字, 语言 zh/ja/en)
    var onPartial: ((String) -> Void)?
    var onStatus: ((String) -> Void)?
    var onSpeakingChanged: ((Bool) -> Void)?
    // 这句话是否已经是完整的命令（能马上处理）
    var isComplete: ((String) -> Bool)?
    // 这段文字值不值得留着（喊过雪人 / 正在等命令）
    var shouldKeep: ((String) -> Bool)?
    // 是否含唤醒词（说话时插话用）
    var hasWake: ((String) -> Bool)?
    private(set) var running = false
    private(set) var langs: [String] = []
    private(set) var echoCancel = false
    private(set) var speaking = false

    // 一个识别出的片段：文字 + 在音频里的时间（秒）
    private struct Seg { let text: String; let start: Double; let end: Double; let conf: Double? }

    private final class Lane {
        let lang: String
        let analyzer: SpeechAnalyzer
        let builder: AsyncStream<AnalyzerInput>.Continuation
        var task: Task<Void, Never>?
        var finals: [Seg] = []
        var volatile: [Seg] = []
        init(lang: String, analyzer: SpeechAnalyzer, builder: AsyncStream<AnalyzerInput>.Continuation) {
            self.lang = lang; self.analyzer = analyzer; self.builder = builder
        }
    }

    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private let synth = AVSpeechSynthesizer()
    private let playFormat = AVAudioFormat(standardFormatWithSampleRate: 24_000, channels: 1)!
    private var lanes: [Lane] = []
    private var analyzerFormat: AVAudioFormat?
    private var tapInstalled = false
    private var playerAttached = false
    private var lastChange = Date()
    private var consumedUntil = 0.0          // 已交给上层的音频时间（秒），之前的词都丢掉
    private var silenceTimer: Timer?
    private var commandStart: Date?
    private let audioClock = AudioClock()
    private let audioGate = AudioGate()       // 没有回声消除时的退路：说话时不送声音
    let realtimeTap = RealtimeTap()           // 实时对话：麦克风声音直接送云端
    private var rtScheduledFrames: AVAudioFramePosition = 0
    private var rtFirstChunkAt: Date?
    private var observers: [NSObjectProtocol] = []
    private var pendingUtterances = 0
    private var speakGeneration = 0

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
            let s = AVAudioSession.sharedInstance()
            try s.setCategory(.playAndRecord, mode: .default, options: [.mixWithOthers, .allowBluetoothA2DP, .defaultToSpeaker])
            try s.setActive(true)

            var transcribers: [(String, SpeechTranscriber)] = []
            for lang in wanted {
                let t = SpeechTranscriber(locale: Self.locale(lang), transcriptionOptions: [],
                                          reportingOptions: [.volatileResults, .fastResults],
                                          attributeOptions: [.transcriptionConfidence, .audioTimeRange])
                if let req = try await AssetInventory.assetInstallationRequest(supporting: [t]) {
                    onStatus?("正在下载\(lang)语音识别模型…")
                    do { try await req.downloadAndInstall() } catch {
                        XLog("[语音] %@ 模型下载失败，先不用：%@", lang, error.localizedDescription)
                        continue
                    }
                }
                transcribers.append((lang, t))
            }
            guard !transcribers.isEmpty else { onStatus?("没有可用的语音识别模型"); return }
            analyzerFormat = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: transcribers.map { $0.1 })

            // iOS 限制同时最多 2 个识别器（第 3 个报“Maximum number of recognizers reached”，真机实测）
            lanes = []
            consumedUntil = 0
            for (lang, t) in transcribers.prefix(2) {
                let a = SpeechAnalyzer(modules: [t])
                let (stream, builder) = AsyncStream<AnalyzerInput>.makeStream()
                let lane = Lane(lang: lang, analyzer: a, builder: builder)
                lane.task = Task { [weak self, weak lane] in
                    do {
                        for try await r in t.results {
                            var segs: [Seg] = []
                            for run in r.text.runs {
                                let piece = String(r.text[run.range].characters)
                                guard !piece.isEmpty else { continue }
                                let tr = run[AttributeScopes.SpeechAttributes.TimeRangeAttribute.self]
                                let start = tr.map { CMTimeGetSeconds($0.start) } ?? .greatestFiniteMagnitude
                                let end = tr.map { CMTimeGetSeconds(CMTimeRangeGetEnd($0)) } ?? .greatestFiniteMagnitude
                                segs.append(Seg(text: piece, start: start, end: end,
                                                conf: run[AttributeScopes.SpeechAttributes.ConfidenceAttribute.self]))
                            }
                            let isFinal = r.isFinal
                            await MainActor.run {
                                guard let self, let lane else { return }
                                self.handle(lane: lane, segs: segs, isFinal: isFinal)
                            }
                        }
                    } catch {
                        XLog("[语音] %@ 识别结束：%@", lang, error.localizedDescription)
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
            silenceTimer = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated { self?.tick() }
            }
            XLog("[语音] 开始听：%@，回声消除：%@", langs.joined(separator: "+"), echoCancel ? "开" : "关（改用说话时不收音）")
            onStatus?("正在听（\(langs.joined(separator: "/"))）")
        } catch {
            XLog("[语音] 启动失败：%@", String(describing: error))
            onStatus?("语音识别启动失败：\(error.localizedDescription)")
            await stop()
        }
    }

    func stop() async {
        stopSpeaking()
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

    // MARK: - 引擎

    private func startEngine() throws {
        let input = engine.inputNode
        // 回声消除 + 降噪；其他 App 的音乐只轻微压低
        do {
            try input.setVoiceProcessingEnabled(true)
            input.voiceProcessingOtherAudioDuckingConfiguration =
                AVAudioVoiceProcessingOtherAudioDuckingConfiguration(enableAdvancedDucking: true, duckingLevel: .min)
            echoCancel = true
        } catch {
            XLog("[语音] 回声消除不可用：%@", error.localizedDescription)
            echoCancel = false
        }
        if !playerAttached {
            engine.attach(player)
            engine.connect(player, to: engine.mainMixerNode, format: playFormat)
            playerAttached = true
        }
        let inFormat = input.outputFormat(forBus: 0)
        guard let outFormat = analyzerFormat, let conv = AVAudioConverter(from: inFormat, to: outFormat) else { return }
        let builders = lanes.map(\.builder)
        let clock = audioClock
        let gate = audioGate
        let rt = realtimeTap
        rt.setInputFormat(inFormat)
        // 在音频线程里转换格式：送给本机识别器；实时对话时同时送给云端（24kHz PCM16）
        input.installTap(onBus: 0, bufferSize: 2048, format: inFormat) { buffer, _ in
            clock.tick()
            if rt.feed(buffer) { return }        // 实时对话中：本机识别器暂停（不需要唤醒词，也省电）
            guard gate.isOpen else { return }
            SpeechInput.convert(buffer, with: conv, to: outFormat, into: builders)
        }
        tapInstalled = true
        engine.prepare()
        try engine.start()
    }

    private func restartEngine(_ why: String) {
        guard running else { return }
        XLog("[语音] 重启麦克风：%@", why)
        audioClock.tick()
        if tapInstalled { engine.inputNode.removeTap(onBus: 0); tapInstalled = false }
        if engine.isRunning { engine.stop() }
        do {
            try AVAudioSession.sharedInstance().setActive(true)
            try startEngine()
        } catch {
            XLog("[语音] 重启失败：%@", error.localizedDescription)
        }
    }

    private func observeAudioSession() {
        let nc = NotificationCenter.default
        observers.append(nc.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] n in
            let raw = n.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
            MainActor.assumeIsolated {
                XLog("[语音] 音频打断：%@", raw == 1 ? "开始" : "结束")
                if raw == 0 { self?.restartEngine("音频打断结束") }
            }
        })
        observers.append(nc.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.restartEngine("音频配置变化") }
        })
    }

    nonisolated private static func convert(_ buffer: AVAudioPCMBuffer, with converter: AVAudioConverter, to outFormat: AVAudioFormat,
                                            into builders: [AsyncStream<AnalyzerInput>.Continuation]) {
        guard let out = convertBuffer(buffer, with: converter, to: outFormat) else { return }
        for b in builders { b.yield(AnalyzerInput(buffer: out)) }
    }

    nonisolated private static func convertBuffer(_ buffer: AVAudioPCMBuffer, with converter: AVAudioConverter, to outFormat: AVAudioFormat) -> AVAudioPCMBuffer? {
        let ratio = outFormat.sampleRate / buffer.format.sampleRate
        let cap = AVAudioFrameCount(Double(buffer.frameLength) * ratio + 1024)
        guard let out = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: cap) else { return nil }
        var consumed = false
        var err: NSError?
        converter.convert(to: out, error: &err) { _, status in
            if consumed { status.pointee = .noDataNow; return nil }
            consumed = true
            status.pointee = .haveData
            return buffer
        }
        return err == nil && out.frameLength > 0 ? out : nil
    }

    // MARK: - 说话（从同一个引擎播出，回声消除才认得出来）

    func speak(_ text: String, voice: AVSpeechSynthesisVoice?) {
        guard running, !text.isEmpty else { return }
        let u = AVSpeechUtterance(string: text)
        u.voice = voice
        SpeechService.tune(u)
        setSpeaking(true)
        pendingUtterances += 1
        let gen = speakGeneration
        if !player.isPlaying { player.play() }
        var converter: AVAudioConverter?
        var chunks = 0
        let fmt = playFormat
        let p = player
        // 保险：预计时长 + 3 秒还没说完，就当说完了（防止合成回调没来时一直处于“说话中”）
        let est = Double(text.count) / 4 + 3
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(est))
            guard let self, gen == self.speakGeneration, self.pendingUtterances > 0 else { return }
            XLog("[语音] 播报超时，强制结束")
            self.utteranceDone(gen, force: true)
        }
        synth.write(u) { [weak self] buf in
            guard let pcm = buf as? AVAudioPCMBuffer else { return }
            if pcm.frameLength == 0 {
                // 这句话合成完了：等最后一段播完再算说完
                XLog("[语音] 合成完成：%d 段", chunks)
                p.scheduleBuffer(AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: 1)!) {
                    Task { @MainActor in self?.utteranceDone(gen) }
                }
                return
            }
            if converter == nil {
                converter = AVAudioConverter(from: pcm.format, to: fmt)
                XLog("[语音] 合成格式：%@ → 播放格式：%@", String(describing: pcm.format), String(describing: fmt))
            }
            guard let c = converter, let out = SpeechInput.convertBuffer(pcm, with: c, to: fmt) else { return }
            chunks += 1
            p.scheduleBuffer(out)
        }
    }

    // MARK: - 实时对话的声音

    // 播放云端传回的一段声音（PCM16 24kHz 单声道），和雪人本地说话走同一个播放器（回声消除认得）
    func playRealtime(_ data: Data) {
        guard running else { return }
        let frames = data.count / 2
        guard frames > 0, let buf = AVAudioPCMBuffer(pcmFormat: playFormat, frameCapacity: AVAudioFrameCount(frames)) else { return }
        buf.frameLength = AVAudioFrameCount(frames)
        let out = buf.floatChannelData![0]
        data.withUnsafeBytes { raw in
            let src = raw.bindMemory(to: Int16.self)
            for i in 0..<frames { out[i] = Float(Int16(littleEndian: src[i])) / 32768 }
        }
        if rtFirstChunkAt == nil { rtFirstChunkAt = Date(); rtScheduledFrames = 0 }
        rtScheduledFrames += AVAudioFramePosition(frames)
        if !player.isPlaying { player.play() }
        setSpeaking(true)
        player.scheduleBuffer(buf)
    }

    // 云端这段回答的声音发完了：等播完再算说完
    func endRealtimeAudio() {
        let gen = speakGeneration
        pendingUtterances += 1
        player.scheduleBuffer(AVAudioPCMBuffer(pcmFormat: playFormat, frameCapacity: 1)!) { [weak self] in
            Task { @MainActor in self?.rtFirstChunkAt = nil; self?.utteranceDone(gen) }
        }
    }

    // 用户插话：立刻停播，返回这段回答已经播了多少毫秒（告诉云端截断）
    func interruptRealtime() -> Int {
        let elapsed = rtFirstChunkAt.map { Date().timeIntervalSince($0) * 1000 } ?? 0
        let scheduledMs = Double(rtScheduledFrames) / 24
        rtFirstChunkAt = nil
        stopSpeaking()
        return Int(min(elapsed, scheduledMs))
    }

    func stopSpeaking() {
        guard speaking || pendingUtterances > 0 else { return }
        speakGeneration += 1
        synth.stopSpeaking(at: .immediate)
        player.stop()
        pendingUtterances = 0
        setSpeaking(false)
    }

    private func utteranceDone(_ gen: Int, force: Bool = false) {
        guard gen == speakGeneration else { return }
        pendingUtterances = force ? 0 : max(0, pendingUtterances - 1)
        if pendingUtterances == 0 { setSpeaking(false) }
    }

    private func setSpeaking(_ on: Bool) {
        guard on != speaking else { return }
        speaking = on
        if !echoCancel {
            // 没有回声消除：说话时不收音，说完 0.6 秒后再收
            if on { audioGate.isOpen = false } else {
                Task { @MainActor in
                    try? await Task.sleep(for: .milliseconds(600))
                    if !self.speaking { self.audioGate.isOpen = true }
                }
            }
        }
        XLog("[语音] %@", on ? "雪人开始说话" : "雪人说完了")
        onSpeakingChanged?(on)
    }

    // MARK: - 识别结果

    private func laneText(_ l: Lane) -> String {
        (l.finals + l.volatile).filter { $0.end > consumedUntil }.map(\.text).joined()
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func laneConfidence(_ l: Lane) -> Double {
        let c = (l.finals + l.volatile).filter { $0.end > consumedUntil }.compactMap(\.conf)
        return c.isEmpty ? 0 : c.reduce(0, +) / Double(c.count)
    }

    private func laneEnd(_ l: Lane) -> Double {
        (l.finals + l.volatile).map(\.end).filter { $0 < .greatestFiniteMagnitude }.max() ?? consumedUntil
    }

    private func handle(lane: Lane, segs: [Seg], isFinal: Bool) {
        if isFinal {
            lane.finals.append(contentsOf: segs)
            lane.volatile = []
            lane.finals.removeAll { $0.end <= consumedUntil }
        } else {
            lane.volatile = segs
        }
        let text = laneText(lane)
        guard !text.isEmpty else { return }
        lastChange = Date()
        // 雪人说话时用户喊“雪人”：打断她（插话）
        if speaking, hasWake?(text) == true {
            XLog("[语音] 用户插话，停止播报")
            stopSpeaking()
        }
        // 唤醒词在哪个语言里出现都算：优先把含唤醒词的那条交给上层
        let texts = lanes.map(laneText).filter { !$0.isEmpty }
        if let withWake = texts.first(where: { shouldKeep?($0) ?? false }) { onPartial?(withWake) }
        else if let b = best() { onPartial?(laneText(b)) }
    }

    // 某个语言的识别器被系统停掉：从候选里去掉，其余继续
    private func laneDied(_ lang: String) {
        lanes.removeAll { $0.lang == lang }
        langs = lanes.map(\.lang)
        onStatus?("正在听（\(langs.joined(separator: "/"))）")
    }

    // 置信度最高的语言（还没有置信度时用文字长度兜底）
    private func best() -> Lane? {
        lanes.filter { !laneText($0).isEmpty }.max { a, b in
            let ca = laneConfidence(a), cb = laneConfidence(b)
            if ca > 0 && cb > 0 { return ca < cb }
            return laneText(a).count < laneText(b).count
        }
    }

    // 把当前所有语言里已识别的内容标记为“用过了”
    private func consumeAll() {
        consumedUntil = max(consumedUntil, lanes.map(laneEnd).max() ?? consumedUntil)
        for l in lanes { l.finals = []; l.volatile = [] }
        commandStart = nil
    }

    private func tick() {
        // 2 秒没收到任何音频：麦克风被系统停了，重启
        if running, audioClock.secondsSinceLast() > 2 { restartEngine("2 秒没有音频") }
        guard let b = best() else { return }
        let quiet = Date().timeIntervalSince(lastChange)
        let complete = lanes.contains { l in let t = laneText(l); return !t.isEmpty && (isComplete?(t) ?? false) }
        let need = complete ? 0.6 : 1.4
        let tooLong = commandStart.map { Date().timeIntervalSince($0) > 7 } ?? false
        guard quiet > need || tooLong else { return }
        // 唤醒词 / 命令可能只在某种语言的结果里：优先用“值得保留”的那条里置信度最高的
        let pick = lanes.filter { let t = laneText($0); return !t.isEmpty && (shouldKeep?(t) ?? false) }
            .max { laneConfidence($0) < laneConfidence($1) } ?? b
        let text = laneText(pick), lang = pick.lang
        let keep = shouldKeep?(text) ?? true
        let summary = lanes.map { "\($0.lang)=\(laneText($0))(\(String(format: "%.2f", laneConfidence($0))))" }.joined(separator: " | ")
        consumeAll()
        guard keep else { return }   // 旁边的人声 / 没喊雪人：丢掉
        // 雪人说话时，没有喊“雪人”的话不算（只可能是回声或旁人）
        if speaking && hasWake?(text) != true { return }
        XLog("[语音] 一句话（停顿 %.1f 秒%@），选 %@：%@  [%@]", quiet, tooLong ? "，超过 7 秒强制结束" : "", lang, text, summary)
        onUtterance?(text, lang)
    }
}

// 实时对话时把麦克风声音转成 24kHz PCM16 交给云端（音频线程调用 feed）
final class RealtimeTap: @unchecked Sendable {
    private let lock = NSLock()
    private var sink: ((Data) -> Void)?
    private var converter: AVAudioConverter?
    private var inFormat: AVAudioFormat?
    private let outFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 24_000, channels: 1, interleaved: true)!

    func setInputFormat(_ f: AVAudioFormat) {
        lock.lock(); inFormat = f; converter = AVAudioConverter(from: f, to: outFormat); lock.unlock()
    }
    func setSink(_ s: ((Data) -> Void)?) { lock.lock(); sink = s; lock.unlock() }
    var active: Bool { lock.lock(); defer { lock.unlock() }; return sink != nil }

    // 返回 true 表示正在实时对话（声音已送云端）
    func feed(_ buffer: AVAudioPCMBuffer) -> Bool {
        lock.lock()
        let s = sink, c = converter
        lock.unlock()
        guard let s, let c else { return false }
        let ratio = outFormat.sampleRate / buffer.format.sampleRate
        let cap = AVAudioFrameCount(Double(buffer.frameLength) * ratio + 256)
        guard let out = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: cap) else { return true }
        var consumed = false
        var err: NSError?
        c.convert(to: out, error: &err) { _, status in
            if consumed { status.pointee = .noDataNow; return nil }
            consumed = true
            status.pointee = .haveData
            return buffer
        }
        guard err == nil, out.frameLength > 0, let ch = out.int16ChannelData else { return true }
        s(Data(bytes: ch[0], count: Int(out.frameLength) * 2))
        return true
    }
}

// 收音开关（主线程写，音频线程读）
final class AudioGate: @unchecked Sendable {
    private var open = true
    private let lock = NSLock()
    var isOpen: Bool {
        get { lock.lock(); defer { lock.unlock() }; return open }
        set { lock.lock(); open = newValue; lock.unlock() }
    }
}

// 音频线程记录“最后一次收到声音”的时间（主线程读）
final class AudioClock: @unchecked Sendable {
    private var last = Date()
    private let lock = NSLock()
    func tick() { lock.lock(); last = Date(); lock.unlock() }
    func secondsSinceLast() -> Double { lock.lock(); defer { lock.unlock() }; return Date().timeIntervalSince(last) }
}
