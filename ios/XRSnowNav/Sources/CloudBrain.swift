// 云端理解：把一句话发给 Claude，拿回意图 JSON（结构见 nav/companion.js 的 INTENT_SCHEMA）。
// 只负责“理解”，路线由本地规划器决定。没有密钥、没网、超时或被拒绝时返回 nil，由本地规则兜底。
// API 密钥只存在本机钥匙串，不写进代码和仓库。

import Foundation
import Security

enum CloudModel: String, CaseIterable, Identifiable {
    case haiku = "claude-haiku-5-5"
    case sonnet = "claude-sonnet-5-5"
    case opus = "claude-opus-5-5"
    var id: String { rawValue }
    var label: String {
        switch self {
        case .haiku: return "Haiku 5.5（最快，推荐）"
        case .sonnet: return "Sonnet 5.5（更聪明，稍慢）"
        case .opus: return "Opus 5.5（最强，最慢）"
        }
    }
    var short: String { self == .haiku ? "Haiku" : self == .sonnet ? "Sonnet" : "Opus" }
    // Opus / Sonnet 支持服务端 fallback（"default"），Haiku 不支持
    var supportsFallback: Bool { self != .haiku }
}

struct BrainTurn: Codable {
    let role: String   // "user" / "assistant"
    let text: String
}

final class CloudBrain {
    var model: CloudModel = .haiku
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
        if model.supportsFallback { req.setValue("server-side-fallback-2026-07-01", forHTTPHeaderField: "anthropic-beta") }
        var b = body
        if !model.supportsFallback { b.removeValue(forKey: "fallbacks") }
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
    // “雪人”对话：Claude 用人设说话，需要导航数据时调用工具（由 JS 导航核心执行）。
    // 返回朗读用的回复；失败返回 nil（上层改用离线规则）。tool 闭包在主线程执行工具并返回 JSON 字符串。
    func converse(text: String, context: String, history: [BrainTurn], system: String, tools: Any,
                  tool: @MainActor (String, String) -> String) async -> String? {
        guard let key = Keychain.read() else { return nil }
        var messages: [[String: Any]] = history.suffix(10).map { ["role": $0.role, "content": $0.text] }
        while let first = messages.first, first["role"] as? String == "assistant" { messages.removeFirst() }
        // 去掉连续同角色（例如上次失败只留下了 user）
        var cleaned: [[String: Any]] = []
        for m in messages {
            if let last = cleaned.last, last["role"] as? String == m["role"] as? String { cleaned[cleaned.count - 1] = m } else { cleaned.append(m) }
        }
        messages = cleaned
        if messages.last?["role"] as? String == "user" { messages.removeLast() }
        messages.append(["role": "user", "content": "【当前状态】\(context)\n【用户说】\(text)"])

        for _ in 0..<5 {
            var body: [String: Any] = [
                "model": model.rawValue,
                "max_tokens": 2048,
                "system": system + "\n\n这是实时语音对话，延迟敏感：尽快给出回复。",
                "tools": tools,
                "messages": messages,
                "output_config": ["effort": "low"]
            ]
            if model.supportsFallback { body["fallbacks"] = "default" }
            guard let obj = await post(body, key: key) else { return nil }
            let stop = obj["stop_reason"] as? String
            let content = obj["content"] as? [[String: Any]] ?? []
            if stop == "refusal" { NSLog("[云端] 被拒绝"); return nil }
            if stop == "tool_use" {
                // 助手消息原样带回（包括 thinking 块），再附上所有工具结果
                messages.append(["role": "assistant", "content": content])
                var results: [[String: Any]] = []
                for block in content where block["type"] as? String == "tool_use" {
                    let id = block["id"] as? String ?? ""
                    let name = block["name"] as? String ?? ""
                    let input = block["input"] ?? [:]
                    let inputJSON = (try? JSONSerialization.data(withJSONObject: input)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
                    let out = await tool(name, inputJSON)
                    NSLog("[云端] 工具 %@ %@ → %@", name, inputJSON, out)
                    results.append(["type": "tool_result", "tool_use_id": id, "content": out])
                }
                messages.append(["role": "user", "content": results])
                continue
            }
            let reply = content.filter { $0["type"] as? String == "text" }.compactMap { $0["text"] as? String }.joined()
                .trimmingCharacters(in: .whitespacesAndNewlines)
            return reply.isEmpty ? nil : reply
        }
        NSLog("[云端] 工具调用轮数过多")
        return nil
    }

    private func post(_ body: [String: Any], key: String) async -> [String: Any]? {
        var req = URLRequest(url: URL(string: "https://api.anthropic.com/v1/messages")!)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.setValue(key, forHTTPHeaderField: "x-api-key")
        req.setValue("2026-10-21", forHTTPHeaderField: "anthropic-version")
        if body["fallbacks"] != nil { req.setValue("server-side-fallback-2026-07-01", forHTTPHeaderField: "anthropic-beta") }
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        do {
            let t0 = Date()
            let (data, resp) = try await session.data(for: req)
            let http = resp as? HTTPURLResponse
            NSLog("[云端] HTTP %d，%.1f 秒", http?.statusCode ?? -1, Date().timeIntervalSince(t0))
            guard http?.statusCode == 200 else {
                NSLog("[云端] 错误：%@", String(data: data, encoding: .utf8)?.prefix(400).description ?? "")
                return nil
            }
            return try JSONSerialization.jsonObject(with: data) as? [String: Any]
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
