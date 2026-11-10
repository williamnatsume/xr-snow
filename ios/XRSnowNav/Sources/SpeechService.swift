// 语音播报：AVSpeechSynthesizer。
// - 不听麦克风时：音频会话 .playback / .voicePrompt / duckOthers，播报时压低音乐，说完恢复。
// - 一直在听（等“雪人”唤醒）时：会话改成 .playAndRecord + mixWithOthers（不长期压低音乐），
//   播报交给系统单独管理的语音会话（usesApplicationAudioSession = false）。这种组合下音乐会不会被压低，需真机验证。
// 锁屏 / 后台也能播（Background Modes: Audio）。onSpeaking 用来在播报时让语音输入静音。

import AVFoundation

@MainActor
final class SpeechService: NSObject, AVSpeechSynthesizerDelegate {
    private let synth = AVSpeechSynthesizer()
    var enabled = true
    var onSpeaking: ((Bool, Double) -> Void)?   // (是否在说, 预计时长秒)
    private(set) var listening = false

    override init() {
        super.init()
        synth.delegate = self
        configure(listening: false)
    }

    // 听的时候说话由 SpeechInput 的引擎负责；这里只在不听时用
    func configure(listening: Bool) {
        self.listening = listening
        let s = AVAudioSession.sharedInstance()
        do {
            if listening {
                synth.usesApplicationAudioSession = false
                try s.setCategory(.playAndRecord, mode: .default, options: [.mixWithOthers, .allowBluetoothA2DP, .defaultToSpeaker])
                try s.setActive(true)
            } else {
                synth.usesApplicationAudioSession = true
                try s.setCategory(.playback, mode: .voicePrompt, options: [.duckOthers, .interruptSpokenAudioAndMixWithOthers])
            }
        } catch {
            XLog("[Speech] 设置音频会话失败：%@", error.localizedDescription)
        }
    }

    var isSpeaking: Bool { synth.isSpeaking }

    // lang: "zh" / "ja"
    func speak(_ text: String, lang: String) {
        guard enabled, !text.isEmpty else { return }
        if !listening {
            do { try AVAudioSession.sharedInstance().setActive(true) } catch {
                XLog("[Speech] 激活音频会话失败：%@", error.localizedDescription)
            }
        }
        let u = AVSpeechUtterance(string: text)
        u.voice = SpeechService.bestVoice(lang == "ja" ? "ja-JP" : lang == "en" ? "en-US" : "zh-CN")
        SpeechService.tune(u)
        // 预计时长：中日文约 4.5 字/秒，英文约 14 字符/秒；多留 2 秒
        let est = Double(text.count) / (lang == "en" ? 14 : 4.5) + 2
        onSpeaking?(true, est)
        synth.speak(u)
    }

    func stop() { synth.stopSpeaking(at: .immediate) }

    // 按文字判断用哪种语言的声音：有假名 → 日语；几乎全是英文字母 → 英语；否则用 fallback
    static func languageOf(_ text: String, fallback: String) -> String {
        let scalars = text.unicodeScalars
        if scalars.contains(where: { (0x3040...0x30FF).contains($0.value) }) { return "ja" }
        let letters = scalars.filter { CharacterSet.letters.contains($0) }
        let latin = letters.filter { $0.isASCII }
        if !letters.isEmpty && Double(latin.count) / Double(letters.count) > 0.8 { return "en" }
        if fallback == "en" || fallback == "ja" { return letters.isEmpty ? fallback : "zh" }
        return fallback
    }

    // 语速、语调：比默认稍快、稍高一点，句间停顿短一点，更像聊天而不是念稿
    static func tune(_ u: AVSpeechUtterance) {
        u.rate = AVSpeechUtteranceDefaultSpeechRate * 1.06
        u.pitchMultiplier = 1.05
        u.preUtteranceDelay = 0
        u.postUtteranceDelay = 0.05
    }

    // 用户在设置里选的声音（空 = 自动选音质最好的）
    static var preferredVoiceId: [String: String] = [:]

    // 选音质最好的声音：高级 > 增强 > 默认（高级/增强声音需在 设置 → 辅助功能 → 朗读内容 → 声音 里下载）
    private static var voiceCache: [String: AVSpeechSynthesisVoice] = [:]
    static func bestVoice(_ language: String) -> AVSpeechSynthesisVoice? {
        if let id = preferredVoiceId[language], let v = AVSpeechSynthesisVoice(identifier: id) { return v }
        if let v = voiceCache[language] { return v }
        let all = AVSpeechSynthesisVoice.speechVoices().filter { $0.language == language }
        let best = all.max { a, b in a.quality.rawValue < b.quality.rawValue } ?? AVSpeechSynthesisVoice(language: language)
        if let best { voiceCache[language] = best; XLog("[Speech] %@ 使用声音：%@（质量 %d）", language, best.name, best.quality.rawValue) }
        return best
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor in self.finished() }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        Task { @MainActor in self.finished() }
    }

    // 没有待播内容时：通知输入恢复；不在听时释放音频会话，让音乐恢复音量
    private func finished() {
        guard !synth.isSpeaking else { return }
        onSpeaking?(false, 0)
        if !listening {
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        }
    }
}
