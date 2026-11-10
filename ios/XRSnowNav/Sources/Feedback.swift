// 听到“雪人”时的即时反馈：轻震 + 短提示音（比说“我在”快得多，也不会盖住用户接着说的话）

import UIKit
import AudioToolbox

@MainActor
enum Haptics {
    private static let gen = UIImpactFeedbackGenerator(style: .medium)
    static func tap() { gen.impactOccurred() }
}

enum Chime {
    // 系统提示音 1113（“开始录音”的短音）
    static func play() { AudioServicesPlaySystemSound(1113) }
}
