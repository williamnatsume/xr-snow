// 语音输入：iOS 26 的 SpeechAnalyzer + SpeechTranscriber，本机离线识别中文 / 日语（用户 iPhone 实测已安装）。
// 持续听：识别出的文字停顿 0.6 秒（命令已完整）或 1.4 秒后算一句话，交给 onUtterance。是否需要唤醒词由上层（NavModel）判断。
// 播报语音时调用 mute(true)，避免把自己的声音当成用户的话。
// 麦克风用 iPhone 自带的（不用 AirPods 通话麦克风，否则蓝牙音乐会变成通话音质）。

import Foundation
import AVFoundation
import Speech

@MainActor
final class SpeechInput {
    var onUtterance: ((String) -> Void)?
    var onPartial: ((String) -> Void)?
    var onStatus: ((String) -> Void)?
    // 这句话是否已经是完整的命令（能马上处理）。是 → 停顿 0.6 秒就算说完；否 → 等 1.4 秒
    var isComplete: ((String) -> Bool)?
    private(set) var running = false

    private let engine = AVAudioEngine()
    private var analyzer: SpeechAnalyzer?
    private var transcriber: SpeechTranscriber?
    private var inputBuilder: AsyncStream<AnalyzerInput>.Continuation?
    private var resultsTask: Task<Void, Never>?
    private var converter: AVAudioConverter?
    private var analyzerFormat: AVAudioFormat?

    private var finalized = ""
    private var volatile = ""
    private var lastChange = Date()
    private var muted = false
    private var mutedUntil = Date.distantPast
    private var silenceTimer: Timer?
    private var tapInstalled = false
    private(set) var lastPartialAt = Date()
    private var locale = Locale(identifier: "zh-CN")

    static func requestMicPermission() async -> Bool {
        await AVAudioApplication.requestRecordPermission()
    }

    func start(lang: String) async {
        guard !running else { return }
        #if targetEnvironment(simulator)
        // 模拟器的麦克风输入会让音频系统超时崩溃（实测），模拟器上只用打字
        onStatus?("模拟器上不支持语音输入，请用键盘打字")
        #else
        await startListening(lang: lang)
        #endif
    }

    private func startListening(lang: String) async {
        guard await Self.requestMicPermission() else { onStatus?("没有麦克风权限：请在 设置 → 雪人 中允许麦克风"); return }
        locale = Locale(identifier: lang == "ja" ? "ja-JP" : "zh-CN")
        do {
            let t = SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [.volatileResults, .fastResults], attributeOptions: [])
            // 模型未安装时下载（用户 iPhone 上中日文已安装）
            if let req = try await AssetInventory.assetInstallationRequest(supporting: [t]) {
                onStatus?("正在下载语音识别模型…")
                try await req.downloadAndInstall()
            }
            let a = SpeechAnalyzer(modules: [t])
            let fmt = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [t])
            transcriber = t
            analyzer = a
            analyzerFormat = fmt

            let (stream, builder) = AsyncStream<AnalyzerInput>.makeStream()
            inputBuilder = builder
            resultsTask = Task { [weak self] in
                do {
                    for try await r in t.results {
                        let text = String(r.text.characters)
                        await MainActor.run { self?.handle(text: text, isFinal: r.isFinal) }
                    }
                } catch {
                    NSLog("[语音] 识别结束：%@", error.localizedDescription)
                }
            }
            try await a.start(inputSequence: stream)
            try startEngine()
            running = true
            silenceTimer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated { self?.checkSilence() }
            }
            NSLog("[语音] 开始听：%@，输入格式 %@", locale.identifier, String(describing: analyzerFormat))
            onStatus?("正在听")
        } catch {
            NSLog("[语音] 启动失败：%@", String(describing: error))
            onStatus?("语音识别启动失败：\(error.localizedDescription)")
            await stop()
        }
    }

    func stop() async {
        silenceTimer?.invalidate(); silenceTimer = nil
        // 只在装过 tap 时才碰 inputNode：没启动成功时访问它会让音频系统超时崩溃（模拟器上实测）
        if tapInstalled { engine.inputNode.removeTap(onBus: 0); tapInstalled = false }
        if engine.isRunning { engine.stop() }
        inputBuilder?.finish(); inputBuilder = nil
        try? await analyzer?.finalizeAndFinishThroughEndOfInput()
        resultsTask?.cancel(); resultsTask = nil
        analyzer = nil; transcriber = nil; converter = nil
        finalized = ""; volatile = ""
        running = false
    }

    // 播报时静音输入；恢复时丢掉期间的识别结果
    func mute(_ on: Bool) {
        muted = on
        if !on { mutedUntil = Date().addingTimeInterval(0.4) }
        finalized = ""; volatile = ""
    }

    private func startEngine() throws {
        let input = engine.inputNode
        let inFormat = input.outputFormat(forBus: 0)
        guard let outFormat = analyzerFormat, let conv = AVAudioConverter(from: inFormat, to: outFormat),
              let builder = inputBuilder else { return }
        converter = conv
        // 在音频线程里转换格式并送给识别器（不碰主线程状态）
        input.installTap(onBus: 0, bufferSize: 4096, format: inFormat) { buffer, _ in
            SpeechInput.convert(buffer, with: conv, to: outFormat, into: builder)
        }
        tapInstalled = true
        engine.prepare()
        try engine.start()
    }

    nonisolated private static func convert(_ buffer: AVAudioPCMBuffer, with converter: AVAudioConverter, to outFormat: AVAudioFormat,
                                            into builder: AsyncStream<AnalyzerInput>.Continuation) {
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
        if err == nil && out.frameLength > 0 { builder.yield(AnalyzerInput(buffer: out)) }
    }

    private func handle(text: String, isFinal: Bool) {
        NSLog("[语音] %@%@%@", isFinal ? "完整：" : "片段：", text, muted || Date() < mutedUntil ? "（播报中，忽略）" : "")
        if muted || Date() < mutedUntil { return }
        if isFinal { finalized += text; volatile = "" } else { volatile = text }
        lastChange = Date()
        let all = (finalized + volatile).trimmingCharacters(in: .whitespaces)
        if !all.isEmpty { onPartial?(all) }
        lastPartialAt = Date()
    }

    private func checkSilence() {
        let all = (finalized + volatile).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !all.isEmpty else { return }
        let quiet = Date().timeIntervalSince(lastChange)
        let need = (isComplete?(all) ?? false) ? 0.6 : 1.4
        guard quiet > need else { return }
        finalized = ""; volatile = ""
        NSLog("[语音] 一句话（停顿 %.1f 秒后）：%@", quiet, all)
        onUtterance?(all)
    }
}
