// OpenAI Realtime（语音进、语音出）：WebSocket wss://api.openai.com/v1/realtime?model=…
// 事件格式按 2026-11 的官方文档（GA 接口，不再需要 OpenAI-Beta 头）：
//   客户端：session.update / input_audio_buffer.append / conversation.item.create / response.create /
//           response.cancel / conversation.item.truncate
//   服务端：session.updated / response.output_audio.delta / response.output_audio.done /
//           response.output_audio_transcript.done / input_audio_buffer.speech_started /
//           conversation.item.input_audio_transcription.completed /
//           response.function_call_arguments.done / response.done / error
// 声音格式：PCM16 单声道 24kHz（base64）。服务端判断用户说完（server_vad），用户插话时服务端自动停止回答。
// 导航工具和 Claude 版本共用（nav/companion.js 的 COMPANION_TOOLS），由 JS 导航核心执行，路线不会被编造。
// API 密钥存本机钥匙串（个人自用；正式发布应改用服务器签发的临时密钥）。

import Foundation

enum RealtimeModel: String, CaseIterable, Identifiable {
    case full = "gpt-realtime-2.1"
    case mini = "gpt-realtime-2.1-mini"
    var id: String { rawValue }
    var label: String { self == .full ? "gpt-realtime-2.1（最聪明）" : "gpt-realtime-2.1-mini（便宜约 3 倍）" }
}

@MainActor
final class RealtimeSession {
    // 回调（主线程）
    var onReady: (() -> Void)?
    var onAudio: ((Data) -> Void)?
    var onAudioDone: (() -> Void)?
    var onUserSpeechStarted: (() -> Void)?
    var onUserText: ((String) -> Void)?
    var onAssistantText: ((String) -> Void)?
    var onToolCall: ((String, String) -> String)?      // (name, argumentsJSON) → 结果 JSON
    var onClosed: ((String?) -> Void)?                  // 原因（nil = 正常关闭）
    var onActivity: (() -> Void)?
    var onAnnounceSpoken: ((String, String) -> Void)?   // (原始播报文字, 实际说出的文字) 用来核对方向
    var onCancelPlayback: (() -> Void)?                 // 紧急播报打断正在说的话：停播本地声音

    private var task: URLSessionWebSocketTask?
    private let urlSession = URLSession(configuration: .default)
    private(set) var ready = false
    private(set) var closed = false
    private var pending: [String] = []                  // 连上前要发的事件
    private var currentItemId: String?                  // 正在播放的助手回答
    private var responding = false
    private let connectedAt = Date()

    func connect(key: String, model: RealtimeModel, voice: String, instructions: String, tools: [[String: Any]]) {
        var req = URLRequest(url: URL(string: "wss://api.openai.com/v1/realtime?model=\(model.rawValue)")!)
        req.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        let t = urlSession.webSocketTask(with: req)
        task = t
        t.resume()
        XLog("[实时] 连接 %@，声音 %@", model.rawValue, voice)
        receive()
        send([
            "type": "session.update",
            "session": [
                "type": "realtime",
                "model": model.rawValue,
                "output_modalities": ["audio"],
                "instructions": instructions,
                "audio": [
                    "input": [
                        "format": ["type": "audio/pcm", "rate": 24000],
                        "noise_reduction": ["type": "near_field"],
                        "transcription": ["model": "gpt-4o-mini-transcribe"],
                        "turn_detection": [
                            "type": "server_vad", "create_response": true, "interrupt_response": true,
                            "prefix_padding_ms": 300, "silence_duration_ms": 450, "threshold": 0.5
                        ]
                    ],
                    "output": ["format": ["type": "audio/pcm", "rate": 24000], "voice": voice]
                ],
                "tools": tools,
                "tool_choice": "auto",
                "reasoning": ["effort": "low"]
            ]
        ], force: true)
    }

    // 唤醒时已经在本机听清的那句话：作为文字直接发过去，让它马上回答
    func sendUserText(_ text: String) {
        send(["type": "conversation.item.create",
              "item": ["type": "message", "role": "user", "content": [["type": "input_text", "text": text]]]])
        send(["type": "response.create"])
    }

    // MARK: - 导航播报（用同一个声音、陪滑口吻说出来）

    private var announceQueue: [(token: String, text: String)] = []
    private var sentAnnounce: [String: String] = [:]                     // token → 原文（等 response.created 带回 token）
    private var announceByResponse: [String: (token: String, text: String)] = [:]
    private var currentResponseId: String?
    private(set) var audioStarted: Set<String> = []     // 已经开始出声的播报 token

    // urgent：岔口主提示等，正在说别的就打断；low：“好嘞，进…了”这类，忙的时候直接不说
    @discardableResult
    func announce(_ text: String, token: String, urgent: Bool, low: Bool = false) -> Bool {
        if low && (responding || !announceQueue.isEmpty) { return false }
        if responding {
            if urgent {
                announceQueue.insert((token, text), at: 0)
                send(["type": "response.cancel"])
                onCancelPlayback?()
            } else {
                announceQueue.append((token, text))
            }
            return true
        }
        sendAnnounce((token, text))
        return true
    }

    private func sendAnnounce(_ a: (token: String, text: String)) {
        sentAnnounce[a.token] = a.text
        responding = true
        let instr = """
        导航播报：用户正在滑雪，马上要用到这条提示。用陪滑朋友的口吻，自然地用一句话说出下面这条提示的意思。
        必须保留方向（靠左 / 靠右 / 走中间那条）和距离数字，不能改动、不能省略；雪道和缆车的名字照原文读（日文名字用日语读音）。
        不要提问，不要加别的话，越短越好，语速轻快。提示：「\(a.text)」
        """
        // metadata 带上 token：response.created 里会带回来，播报和回答一一对应（排队、打断时不会串）
        send(["type": "response.create", "response": ["instructions": instr, "tool_choice": "none", "metadata": ["announce": a.token]]])
    }

    func cancelAnnouncement(_ token: String) {
        if let rid = announceByResponse.first(where: { $0.value.token == token })?.key {
            send(["type": "response.cancel", "response_id": rid])
            announceByResponse[rid] = nil     // 已经改用本机说了：不再核对，避免重复纠正
        }
        sentAnnounce[token] = nil
        announceQueue.removeAll { $0.token == token }
    }

    // 只喊了“雪人”：让它先打个招呼
    func greet(_ hint: String) {
        send(["type": "response.create", "response": ["instructions": hint]])
    }

    func appendAudio(_ pcm: Data) {
        guard ready else { return }       // 连上之前的声音不送（太短，且会乱序）
        send(["type": "input_audio_buffer.append", "audio": pcm.base64EncodedString()])
    }

    // 用户插话：截掉还没播的部分，云端记录和实际听到的一致
    func truncate(playedMs: Int) {
        guard let id = currentItemId else { return }
        send(["type": "conversation.item.truncate", "item_id": id, "content_index": 0, "audio_end_ms": max(0, playedMs)])
        currentItemId = nil
    }

    func close(_ reason: String? = nil) {
        guard !closed else { return }
        closed = true
        ready = false
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
        XLog("[实时] 关闭：%@（持续 %.0f 秒）", reason ?? "正常", Date().timeIntervalSince(connectedAt))
        onClosed?(reason)
    }

    // MARK: - 收发

    private func send(_ obj: [String: Any], force: Bool = false) {
        guard let d = try? JSONSerialization.data(withJSONObject: obj), let s = String(data: d, encoding: .utf8) else { return }
        if !ready && !force { pending.append(s); return }
        task?.send(.string(s)) { [weak self] err in
            if let err { Task { @MainActor in self?.close("发送失败：\(err.localizedDescription)") } }
        }
    }

    private func receive() {
        task?.receive { [weak self] result in
            Task { @MainActor in
                guard let self, !self.closed else { return }
                switch result {
                case .failure(let e):
                    self.close("连接断开：\(e.localizedDescription)")
                case .success(let msg):
                    if case .string(let s) = msg { self.handle(s) }
                    else if case .data(let d) = msg, let s = String(data: d, encoding: .utf8) { self.handle(s) }
                    self.receive()
                }
            }
        }
    }

    private func handle(_ text: String) {
        guard let d = text.data(using: .utf8), let ev = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
              let type = ev["type"] as? String else { return }
        switch type {
        case "session.updated":
            if !ready {
                ready = true
                XLog("[实时] 就绪（%.2f 秒）", Date().timeIntervalSince(connectedAt))
                let queued = pending; pending = []
                for s in queued { task?.send(.string(s)) { _ in } }
                onReady?()
            }
        case "response.created":
            responding = true
            let rid = (ev["response"] as? [String: Any])?["id"] as? String
            currentResponseId = rid
            let meta = (ev["response"] as? [String: Any])?["metadata"] as? [String: Any]
            if let token = meta?["announce"] as? String, let rid {
                if let text = sentAnnounce.removeValue(forKey: token) { announceByResponse[rid] = (token, text) }
                else { send(["type": "response.cancel", "response_id": rid]) }   // 已经改用本机说了：取消
            }
            onActivity?()
        case "response.output_audio.delta":
            if let rid = ev["response_id"] as? String, let a = announceByResponse[rid] { audioStarted.insert(a.token) }
            if let b64 = ev["delta"] as? String, let pcm = Data(base64Encoded: b64) {
                currentItemId = ev["item_id"] as? String ?? currentItemId
                onAudio?(pcm)
                onActivity?()
            }
        case "response.output_audio.done":
            onAudioDone?()
        case "response.output_audio_transcript.done":
            if let t = ev["transcript"] as? String, !t.isEmpty {
                if let rid = ev["response_id"] as? String, let a = announceByResponse[rid] { onAnnounceSpoken?(a.text, t) }
                else { onAssistantText?(t) }
            }
        case "input_audio_buffer.speech_started":
            onUserSpeechStarted?()
            onActivity?()
        case "conversation.item.input_audio_transcription.completed":
            if let t = ev["transcript"] as? String {
                let clean = t.trimmingCharacters(in: .whitespacesAndNewlines)
                if !clean.isEmpty { onUserText?(clean) }
            }
        case "response.function_call_arguments.done":
            let name = ev["name"] as? String ?? ""
            let args = ev["arguments"] as? String ?? "{}"
            let callId = ev["call_id"] as? String ?? ""
            let out = onToolCall?(name, args) ?? "{\"error\":\"没有处理\"}"
            XLog("[实时] 工具 %@ %@ → %@", name, args, String(out.prefix(200)))
            send(["type": "conversation.item.create", "item": ["type": "function_call_output", "call_id": callId, "output": out]])
            needsResponseAfterTools = true
        case "response.done":
            responding = false
            if let rid = (ev["response"] as? [String: Any])?["id"] as? String { announceByResponse[rid] = nil }
            // 这轮回答里调用了工具：把结果交回去，让它接着说
            if needsResponseAfterTools { needsResponseAfterTools = false; send(["type": "response.create"]) }
            if let r = ev["response"] as? [String: Any], let status = r["status"] as? String, status == "failed" {
                XLog("[实时] 回答失败：%@", String(describing: r["status_details"] ?? ""))
            }
            if !needsResponseAfterTools, !announceQueue.isEmpty { sendAnnounce(announceQueue.removeFirst()) }
            onActivity?()
        case "error":
            let e = ev["error"] as? [String: Any]
            let msg = e?["message"] as? String ?? text
            let code = e?["code"] as? String ?? ""
            XLog("[实时] 错误 %@：%@", code, msg)
            // 鉴权、额度等致命错误：关掉，上层退回 Claude / 离线
            if ["invalid_api_key", "insufficient_quota", "model_not_found"].contains(code) || msg.contains("Incorrect API key") {
                close("\(code) \(msg)")
            }
        default:
            break
        }
    }

    private var needsResponseAfterTools = false
}

// OpenAI 的 API 密钥（和 Anthropic 的分开存）
enum OpenAIKeychain {
    private static let service = "io.github.williamnatsume.XRSnowNav"
    private static let account = "openai-api-key"

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
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
        SecItemDelete(q as CFDictionary)
    }
}
