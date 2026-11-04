// 云端理解：把一句话发给 Claude，拿回意图 JSON（结构见 nav/companion.js 的 INTENT_SCHEMA）。
// 只负责“理解”，路线由本地规划器决定。没有密钥、没网、超时或被拒绝时返回 nil，由本地规则兜底。
// API 密钥只存在本机钥匙串，不写进代码和仓库。

import Foundation
import Security

enum CloudModel: String, CaseIterable, Identifiable {
    case opus = "claude-opus-5-5"
    case haiku = "claude-haiku-5-5"
    var id: String { rawValue }
    var label: String { self == .opus ? "Opus 5.5（理解最好）" : "Haiku 5.5（更快更便宜）" }
}

struct BrainTurn: Codable {
    let role: String   // "user" / "assistant"
    let text: String
}

final class CloudBrain {
    var model: CloudModel = .opus
    private let session: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.timeoutIntervalForRequest = 10
        c.timeoutIntervalForResource = 12
        c.waitsForConnectivity = false
        return URLSession(configuration: c)
    }()

    var hasKey: Bool { Keychain.read() != nil }

    // system / schema 来自 navcore.js 的 brainPrompt()；context 是一行当前状态
    func interpret(text: String, context: String, history: [BrainTurn], system: String, schema: Any) async -> String? {
        guard let key = Keychain.read() else { return nil }
        var messages: [[String: Any]] = history.suffix(6).map { ["role": $0.role, "content": $0.text] }
        // 消息必须从 user 开始、user/assistant 交替：去掉开头的 assistant
        while let first = messages.first, first["role"] as? String == "assistant" { messages.removeFirst() }
        messages.append(["role": "user", "content": "【当前状态】\(context)\n【用户说】\(text)"])

        let body: [String: Any] = [
            "model": model.rawValue,
            "max_tokens": 2048,
            "system": system + "\n\n这是实时语音对话，延迟敏感：立即给出结果。",
            "messages": messages,
            "output_config": [
                "effort": "low",
                "format": ["type": "json_schema", "schema": schema]
            ],
            "fallbacks": "default"
        ]
        var req = URLRequest(url: URL(string: "https://api.anthropic.com/v1/messages")!)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.setValue(key, forHTTPHeaderField: "x-api-key")
        req.setValue("2026-10-21", forHTTPHeaderField: "anthropic-version")
        if model == .opus { req.setValue("server-side-fallback-2026-07-01", forHTTPHeaderField: "anthropic-beta") }
        var b = body
        if model != .opus { b.removeValue(forKey: "fallbacks") }   // Haiku 不支持服务端 fallback
        req.httpBody = try? JSONSerialization.data(withJSONObject: b)

        do {
            let (data, resp) = try await session.data(for: req)
            guard let http = resp as? HTTPURLResponse else { return nil }
            guard http.statusCode == 200 else {
                NSLog("[云端] HTTP %d：%@", http.statusCode, String(data: data, encoding: .utf8)?.prefix(300).description ?? "")
                return nil
            }
            guard let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
            if obj["stop_reason"] as? String == "refusal" { NSLog("[云端] 被拒绝"); return nil }
            let blocks = obj["content"] as? [[String: Any]] ?? []
            guard let text = blocks.first(where: { $0["type"] as? String == "text" })?["text"] as? String else { return nil }
            // 校验是合法 JSON 对象
            guard let d = text.data(using: .utf8), (try? JSONSerialization.jsonObject(with: d)) is [String: Any] else { return nil }
            return text
        } catch {
            NSLog("[云端] 请求失败：%@", error.localizedDescription)
            return nil
        }
    }
}

// API 密钥存钥匙串（仅本机、解锁后可用）
enum Keychain {
    private static let service = "io.github.williamnatsume.XRSnowNav"
    private static let account = "anthropic-api-key"

    static func save(_ key: String) {
        delete()
        let q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
            kSecValueData as String: Data(key.utf8)
        ]
        SecItemAdd(q as CFDictionary, nil)
    }

    static func read() -> String? {
        let q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var out: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data,
              let s = String(data: d, encoding: .utf8), !s.isEmpty else { return nil }
        return s
    }

    static func delete() {
        let q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        SecItemDelete(q as CFDictionary)
    }
}
