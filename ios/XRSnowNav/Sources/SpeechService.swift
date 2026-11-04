// 语音播报：AVSpeechSynthesizer。播报时压低音乐音量（duck），说完恢复；锁屏 / 后台也能播（Background Modes: Audio）。

import AVFoundation

@MainActor
final class SpeechService: NSObject, AVSpeechSynthesizerDelegate {
    private let synth = AVSpeechSynthesizer()
    var enabled = true

    override init() {
        super.init()
        synth.delegate = self
        let s = AVAudioSession.sharedInstance()
        do {
            try s.setCategory(.playback, mode: .voicePrompt, options: [.duckOthers, .interruptSpokenAudioAndMixWithOthers])
        } catch {
            NSLog("[Speech] 设置音频会话失败：%@", error.localizedDescription)
        }
    }

    // lang: "zh" / "ja"
    func speak(_ text: String, lang: String) {
        guard enabled, !text.isEmpty else { return }
        do { try AVAudioSession.sharedInstance().setActive(true) } catch {
            NSLog("[Speech] 激活音频会话失败：%@", error.localizedDescription)
        }
        let u = AVSpeechUtterance(string: text)
        u.voice = AVSpeechSynthesisVoice(language: lang == "ja" ? "ja-JP" : "zh-CN")
        u.rate = AVSpeechUtteranceDefaultSpeechRate
        synth.speak(u)
    }

    func stop() { synth.stopSpeaking(at: .immediate) }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor in self.deactivateIfIdle() }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        Task { @MainActor in self.deactivateIfIdle() }
    }

    // 没有待播内容时释放音频会话，让音乐恢复音量
    private func deactivateIfIdle() {
        guard !synth.isSpeaking else { return }
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}
