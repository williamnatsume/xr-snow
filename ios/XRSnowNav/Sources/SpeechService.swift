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
    var onSpeaking: ((Bool) -> Void)?
    private(set) var listening = false

    override init() {
        super.init()
        synth.delegate = self
        configure(listening: false)
    }

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
            NSLog("[Speech] 设置音频会话失败：%@", error.localizedDescription)
        }
    }

    var isSpeaking: Bool { synth.isSpeaking }

    // lang: "zh" / "ja"
    func speak(_ text: String, lang: String) {
        guard enabled, !text.isEmpty else { return }
        if !listening {
            do { try AVAudioSession.sharedInstance().setActive(true) } catch {
                NSLog("[Speech] 激活音频会话失败：%@", error.localizedDescription)
            }
        }
        let u = AVSpeechUtterance(string: text)
        u.voice = SpeechService.bestVoice(lang == "ja" ? "ja-JP" : "zh-CN")
        u.rate = AVSpeechUtteranceDefaultSpeechRate
        onSpeaking?(true)
        synth.speak(u)
    }

    func stop() { synth.stopSpeaking(at: .immediate) }

    // 选音质最好的声音：高级 > 增强 > 默认（高级/增强声音需在 设置 → 辅助功能 → 朗读内容 → 声音 里下载）
    private static var voiceCache: [String: AVSpeechSynthesisVoice] = [:]
    static func bestVoice(_ language: String) -> AVSpeechSynthesisVoice? {
        if let v = voiceCache[language] { return v }
        let all = AVSpeechSynthesisVoice.speechVoices().filter { $0.language == language }
        let best = all.max { a, b in a.quality.rawValue < b.quality.rawValue } ?? AVSpeechSynthesisVoice(language: language)
        if let best { voiceCache[language] = best; NSLog("[Speech] %@ 使用声音：%@（质量 %d）", language, best.name, best.quality.rawValue) }
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
        onSpeaking?(false)
        if !listening {
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        }
    }
}
