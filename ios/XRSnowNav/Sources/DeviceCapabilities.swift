// 设备能力检查：本机大模型（Apple Intelligence / Foundation Models）、本机语音识别是否可用。
// 国行 iPhone 的 Apple Intelligence 状态不确定，以真机检查结果为准。启动参数 -selfcheck 时会写日志 [能力]。

import Foundation
import Speech
import AVFoundation
#if canImport(FoundationModels)
import FoundationModels
#endif

enum DeviceCapabilities {
    static func report() async -> [String] {
        var lines: [String] = []
        lines.append("地区设置：\(Locale.current.region?.identifier ?? "?")，语言：\(Locale.preferredLanguages.first ?? "?")")

        #if canImport(FoundationModels)
        if #available(iOS 26.0, *) {
            switch SystemLanguageModel.default.availability {
            case .available:
                lines.append("本机大模型：可用")
            case .unavailable(let reason):
                lines.append("本机大模型：不可用（\(String(describing: reason))）")
            }
        } else {
            lines.append("本机大模型：系统版本过低")
        }
        #else
        lines.append("本机大模型：SDK 不含 FoundationModels")
        #endif

        for id in ["zh-CN", "ja-JP"] {
            let r = SFSpeechRecognizer(locale: Locale(identifier: id))
            let onDevice = r?.supportsOnDeviceRecognition == true
            lines.append("语音识别 \(id)：\(r == nil ? "不支持" : (onDevice ? "支持本机离线识别" : "仅联网识别"))")
        }

        if #available(iOS 26.0, *) {
            let supported = await SpeechTranscriber.supportedLocales.map { $0.identifier(.bcp47) }
            let installed = await SpeechTranscriber.installedLocales.map { $0.identifier(.bcp47) }
            for id in ["zh-CN", "ja-JP"] {
                let s = supported.contains { $0.hasPrefix(id) }
                let i = installed.contains { $0.hasPrefix(id) }
                lines.append("长时转写 \(id)：\(s ? (i ? "已安装" : "支持，需下载模型") : "不支持")")
            }
        }
        // 已安装的中文 / 日语声音（质量：1 默认 2 增强 3 高级）
        for lang in ["zh-CN", "ja-JP"] {
            // 只在主线程取声音列表：和主线程同时调用会在 TextToSpeech 里互相等死（模拟器上必现）
            let vs = await MainActor.run { AVSpeechSynthesisVoice.speechVoices() }.filter { $0.language == lang }
                .map { "\($0.name)(\($0.quality.rawValue))" }
            lines.append("声音 \(lang)：\(vs.joined(separator: "、"))")
        }
        return lines
    }
}
