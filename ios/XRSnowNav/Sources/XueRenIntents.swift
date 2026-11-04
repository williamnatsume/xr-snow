// Siri / 快捷指令 / iPhone 侧面操作按钮：“和雪人说话” → 打开 App 并开始听（不用喊“雪人”）。
// 操作按钮：设置 → 操作按钮 → 快捷指令 → 选“和雪人说话”。

import AppIntents
import Foundation

extension Notification.Name {
    static let xueRenListen = Notification.Name("XueRenListen")
}

// App 冷启动时模型还没建好，先记下来
@MainActor
enum XueRenIntentState {
    static var pendingListen = false
}

struct TalkToXueRenIntent: AppIntent {
    static let title: LocalizedStringResource = "和雪人说话"
    static let description = IntentDescription("打开雪人并开始听你说话")
    static let openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult {
        XueRenIntentState.pendingListen = true
        NotificationCenter.default.post(name: .xueRenListen, object: nil)
        return .result()
    }
}

struct XueRenShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: TalkToXueRenIntent(),
            phrases: [
                "和\(.applicationName)说话",
                "叫\(.applicationName)",
                "打开\(.applicationName)导航"
            ],
            shortTitle: "和雪人说话",
            systemImageName: "mic.fill"
        )
    }
}
