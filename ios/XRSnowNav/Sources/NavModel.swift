// App 状态：“雪人”对话 → 意图（云端 Claude，失败时本地规则）→ 导航核心（JS）→ 语音回复。
// 也负责：定位（真实 GPS）、模拟器计时、轨迹记录 / 锁屏测试、唤醒词监听。

import Foundation
import AVFoundation
import CoreLocation
import Observation
import UIKit

struct ChatLine: Identifiable {
    enum Who { case user, xueren, system }
    let id = UUID()
    let who: Who
    var text: String
    var note: String? = nil
}

@MainActor
@Observable
final class NavModel {
    enum Mode: String, CaseIterable, Identifiable {
        case sim = "模拟器", gps = "真实 GPS"
        var id: String { rawValue }
    }

    // 打包进 App 的雪场（Resources 里的 json 文件名）
    let resortIds = ["demo-fictional", "kagura-osm"]

    // 设置（存在 UserDefaults）
    var resortId: String { didSet { if resortId != oldValue { save(); loadResort() } } }
    var simStartNode: String { didSet { save(); configureSession() } }
    // 导航播报语言（神乐自动用日语，因为雪道名是假名）
    var lang: String { didSet { save(); session?.setLang(lang) } }
    // 用户说话、雪人回话的语言（语音识别用这个），和播报语言分开
    var talkLang: String { didSet { save(); session?.setTalkLang(talkLang); Task { await restartListening() } } }
    // 第二语言：和“我说的语言”同时听（日语或英语）
    var secondLang: String { didSet { save(); Task { await restartListening() } } }
    var voiceOn: Bool { didSet { save(); speech.enabled = voiceOn; if !voiceOn { stopTalking() } } }
    var wakeWordOn: Bool { didSet { save(); Task { await updateListening() } } }
    var mode: Mode { didSet { save(); configureSession(); updateLocation() } }
    var simSpeed: Double { didSet { save(); if simTimer != nil { startSimTimer() } } }
    var cloudModel: CloudModel { didSet { save(); brain.model = cloudModel } }
    var recordWhileNav: Bool { didSet { save() } }
    // 雪人的中文声音（空 = 自动选音质最好的）
    var voiceId: String { didSet { save(); SpeechService.preferredVoiceId["zh-CN"] = voiceId.isEmpty ? nil : voiceId } }
    var dataAck = false

    // 状态
    var info: ResortInfo?
    var snapshot: NavSnapshot?
    var chat: [ChatLine] = []
    var partial = ""
    var listening = false
    var thinking = false
    var commandWindowOpen = false
    var paused = false
    var status: String?
    var selfCheck: SelfCheckResult?
    var capabilities: [String] = []
    var fatalError: String?
    var hasKey = false
    // 实时语音（OpenAI Realtime）
    var realtimeOn: Bool { didSet { save() } }
    var rtModel: RealtimeModel { didSet { save() } }
    var rtVoice: String { didSet { save() } }
    var hasOpenAIKey = false
    var rtActive = false
    var testing = false
    var trackStats = TrackStats()
    var lastTrackFile: URL?

    var navigating: Bool { snapshot.map { $0.state != "idle" } ?? false }
    var places: [Place] { info?.places ?? [] }
    var needsAck: Bool { info?.dataStatus != "fictional" }

    private var core: NavCore?
    private var session: NavSession?
    private let speech = SpeechService()
    private let input = SpeechInput()
    private let location = LocationService()
    private let brain = CloudBrain()
    private let recorder = TrackRecorder()
    private var simTimer: Timer?
    private var tickTimer: Timer?
    private var history: [BrainTurn] = []
    private var commandWindowUntil = Date.distantPast
    private var lastStatusReport = Date()
    private var gapAnnounced = false
    private var lastNavState = "idle"
    private var wakeAcked = false
    private var replyLang = "zh"
    var speakingNow = false
    private var lastSpeakEnd = Date.distantPast
    private var cloudStartedNav = false
    private var runsToday = 0
    private var navStartedAt = Date()
    private var navPlanKm = 0.0
    private var maxSpeed = 0.0

    init() {
        let d = UserDefaults.standard
        resortId = d.string(forKey: "resortId") ?? "demo-fictional"
        simStartNode = d.string(forKey: "simStartNode") ?? "S"
        lang = d.string(forKey: "lang") ?? "zh"
        talkLang = d.string(forKey: "talkLang") ?? "zh"
        secondLang = d.string(forKey: "secondLang") ?? "ja"
        voiceOn = d.object(forKey: "voiceOn") as? Bool ?? true
        wakeWordOn = d.object(forKey: "wakeWordOn") as? Bool ?? true
        mode = Mode(rawValue: d.string(forKey: "mode") ?? "") ?? .sim
        simSpeed = d.object(forKey: "simSpeed") as? Double ?? 1
        cloudModel = CloudModel(rawValue: d.string(forKey: "cloudModel2") ?? "") ?? .haiku
        recordWhileNav = d.object(forKey: "recordWhileNav") as? Bool ?? true
        voiceId = d.string(forKey: "voiceId") ?? ""
        realtimeOn = d.object(forKey: "realtimeOn") as? Bool ?? true
        rtModel = RealtimeModel(rawValue: d.string(forKey: "rtModel") ?? "") ?? .full
        rtVoice = d.string(forKey: "rtVoice") ?? "marin"
        SpeechService.preferredVoiceId["zh-CN"] = voiceId.isEmpty ? nil : voiceId

        do { core = try NavCore() } catch { fatalError = error.localizedDescription; return }
        brain.model = cloudModel
        hasKey = brain.hasKey
        hasOpenAIKey = OpenAIKeychain.read() != nil
        location.onLocation = { [weak self] loc in self?.handle(loc) }
        location.onStatus = { [weak self] s in self?.status = s }
        input.hasWake = { [weak self] t in self?.session?.hasWake(t) ?? false }
        input.onSpeakingChanged = { [weak self] on in
            self?.speakingNow = on
            if !on { self?.lastSpeakEnd = Date() }
        }
        input.onPartial = { [weak self] t in self?.onPartial(t) }
        input.isComplete = { [weak self] t in self?.looksComplete(t) ?? false }
        input.shouldKeep = { [weak self] t in self?.shouldKeep(t) ?? false }
        input.onUtterance = { [weak self] t, lang in self?.heard(t, lang: lang) }
        input.onStatus = { [weak self] s in self?.status = s; XLog("[语音状态] %@", s) }
        NotificationCenter.default.addObserver(forName: .xueRenListen, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.talkButton() }
        }
        loadResort()
        if ProcessInfo.processInfo.arguments.contains("-selfcheck") { runSelfCheck() }
        Task { await checkCapabilities() }
        tickTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.everySecond() }
        }
        if XueRenIntentState.pendingListen { XueRenIntentState.pendingListen = false; talkButton() }
        Task { await updateListening() }
        // 测试用：启动参数 -say "一句话" 可以重复多次，启动后按顺序当作用户说的话
        let args = ProcessInfo.processInfo.arguments
        let scripted = args.indices.filter { args[$0] == "-say" && $0 + 1 < args.count }.map { args[$0 + 1] }
        // 测试用：-rtsay "一句话" 走实时语音（需要 OpenAI 密钥）
        if let i = args.firstIndex(of: "-rtsay"), i + 1 < args.count {
            let line = args[i + 1]
            Task {
                try? await Task.sleep(for: .seconds(2))
                self.chat.append(ChatLine(who: .user, text: line))
                await self.updateListening()
                self.startRealtimeTurn(text: line, greet: false)
            }
        }
        if !scripted.isEmpty {
            Task {
                for line in scripted {
                    try? await Task.sleep(for: .seconds(1.5))
                    await command(session?.stripWake(line) ?? line)
                }
            }
        }
    }

    private func save() {
        let d = UserDefaults.standard
        d.set(resortId, forKey: "resortId"); d.set(simStartNode, forKey: "simStartNode"); d.set(lang, forKey: "lang"); d.set(talkLang, forKey: "talkLang"); d.set(secondLang, forKey: "secondLang")
        d.set(voiceOn, forKey: "voiceOn"); d.set(wakeWordOn, forKey: "wakeWordOn"); d.set(mode.rawValue, forKey: "mode")
        d.set(simSpeed, forKey: "simSpeed"); d.set(cloudModel.rawValue, forKey: "cloudModel2"); d.set(recordWhileNav, forKey: "recordWhileNav"); d.set(voiceId, forKey: "voiceId")
        d.set(realtimeOn, forKey: "realtimeOn"); d.set(rtModel.rawValue, forKey: "rtModel"); d.set(rtVoice, forKey: "rtVoice")
    }

    func loadResort() {
        stopNav()
        guard let core else { return }
        do {
            let s = try core.session(resortId: resortId)
            session = s
            info = s.info()
            if info?.allowRealGps != true { mode = .sim }
            if !places.contains(where: { $0.node == simStartNode }) { simStartNode = places.first?.node ?? "" }
            // 神乐的雪道名是日文，中文语音读不出假名
            lang = resortId == "demo-fictional" ? "zh" : "ja"
            s.setLang(lang)
            s.setTalkLang(talkLang)
            configureSession()
            updateLocation()
            history = []
        } catch {
            status = error.localizedDescription
        }
    }

    private func configureSession() {
        session?.configure(mode: mode == .sim ? "sim" : "gps", startNode: simStartNode, seed: Int.random(in: 1...99_999))
    }

    // MARK: - 说话

    // 大按钮 / 操作按钮 / Siri：打开一个“直接说，不用喊雪人”的窗口
    func talkButton() {
        XueRenIntentState.pendingListen = false
        stopTalking()
        if useRealtime {
            Haptics.tap(); Chime.play()
            Task { await updateListening(); startRealtimeTurn(text: nil, greet: false) }
            return
        }
        openCommandWindow(seconds: 8)
        Task { await updateListening() }
    }

    func setOpenAIKey(_ key: String) {
        let k = key.trimmingCharacters(in: .whitespacesAndNewlines)
        if k.isEmpty { OpenAIKeychain.delete() } else { OpenAIKeychain.save(k) }
        hasOpenAIKey = OpenAIKeychain.read() != nil
    }

    func setKey(_ key: String) {
        let k = key.trimmingCharacters(in: .whitespacesAndNewlines)
        if k.isEmpty { Keychain.delete() } else { Keychain.save(k) }
        hasKey = brain.hasKey
    }

    // 手动输入文字（模拟器上、或太吵时）
    func submitText(_ text: String) {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        Task { await command(session?.stripWake(t) ?? t) }
    }

    private func openCommandWindow(seconds: Double) {
        commandWindowUntil = Date().addingTimeInterval(seconds)
        commandWindowOpen = true
    }

    // 需要麦克风：开了唤醒词，或者有打开的命令窗口
    private func updateListening() async {
        let want = wakeWordOn || Date() < commandWindowUntil || rtActive
        if want && !input.running {
            speech.stop()
            await input.start(langs: listenLangs)
            listening = input.running
        } else if !want && input.running {
            await input.stop()
            speech.configure(listening: false)
            listening = false
            partial = ""
        }
    }

    // 识别中的片段：一听到“雪人”马上回应（不等这句话说完）
    private func onPartial(_ text: String) {
        partial = text
        guard let session, !wakeAcked, session.hasWake(text) else { return }
        wakeAcked = true
        input.markCommandStart()
        openCommandWindow(seconds: 10)
        Haptics.tap()
        Chime.play()
        // 实时语音：一听到“雪人”就先连上（用户还在说后半句时就在连，省时间）
        if useRealtime { rtWaitingLocal = true; ensureRealtime(); return }
        // 0.7 秒后如果喊完“雪人”还没接着说，就回一声“我在”
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(700))
            if self.wakeAcked, session.afterWake(self.partial).isEmpty { self.reply("我在", note: "唤醒") }
        }
    }

    // 唤醒词后的话已经能听懂（离线规则认得出意图）→ 不用再等
    private func looksComplete(_ text: String) -> Bool {
        guard let session else { return false }
        let woke = session.hasWake(text)
        guard woke || Date() < commandWindowUntil else { return false }
        let cmd = session.stripWake(text)
        if cmd.isEmpty { return false }
        let intent = session.understandLocal(cmd)
        return !intent.contains("\"intent\":\"unknown\"")
    }

    // 同时听两种语言（iOS 最多 2 个识别器）：“我说的语言” + “第二语言”
    private var listenLangs: [String] { secondLang == talkLang ? [talkLang] : [talkLang, secondLang] }

    // 识别结果和雪人最近说过的话大部分重合 → 是扬声器的回声
    private var recentSpoken: [String] = []
    // 在听的时候从语音管线的引擎播出（回声消除需要），否则用普通的系统语音
    private func speakOut(_ text: String, lang: String) {
        guard voiceOn, !text.isEmpty else { return }
        if input.running {
            input.speak(text, voice: SpeechService.bestVoice(lang == "ja" ? "ja-JP" : lang == "en" ? "en-US" : "zh-CN"))
        } else {
            speech.speak(text, lang: lang)
        }
    }

    // 设置里试听声音
    func previewVoice() {
        speakOut("嗨，我是雪人。今天雪不错，咱们去滑两趟吧！", lang: "zh")
    }

    // 可选的中文声音：(id, 显示名)，音质好的排前面
    var zhVoices: [(String, String)] {
        AVSpeechSynthesisVoice.speechVoices().filter { $0.language == "zh-CN" }
            .sorted { $0.quality.rawValue > $1.quality.rawValue }
            .map { v in
                let q = v.quality == .premium ? "高级" : v.quality == .enhanced ? "增强" : "普通"
                return (v.identifier, "\(v.name)（\(q)）")
            }
    }

    // MARK: - 实时语音（OpenAI Realtime）

    private var rtSession: RealtimeSession?
    private var rtLastActivity = Date()
    private var rtPendingText: String?
    private var rtPendingGreet = false
    private var rtFallbackText: String?
    private var rtStreaming = false        // 麦克风正在直送云端
    private var rtWarmSince: Date?         // 不送声音、只保持连接（下次唤醒免去连接时间）
    private var rtWaitingLocal = false     // 预先连接时，等本机把这句话听完再交给云端

    var useRealtime: Bool { realtimeOn && hasOpenAIKey }

    // 建立连接（如果还没有）；连上后由 startRealtimeTurn 决定先说什么
    private func ensureRealtime() {
        guard rtSession == nil, let session, let key = OpenAIKeychain.read(), let p = session.companionPrompt() else { return }
        let tools: [[String: Any]] = (p.tools as? [[String: Any]] ?? []).map {
            ["type": "function", "name": $0["name"] ?? "", "description": $0["description"] ?? "", "parameters": $0["input_schema"] ?? [:]]
        }
        let instructions = p.system + """

        你现在通过实时语音和用户对话：直接听用户的声音，用自然、像真人朋友的语气和语调说话，语速轻快，可以有情绪。
        每次只说一两句，说完就停，把话轮还给用户；用户插话时马上停下听。不要念出工具名字或 JSON。
        """ + "\n【开始时的状态】" + contextLine()
        let rt = RealtimeSession()
        rtSession = rt
        rtActive = true
        rtLastActivity = Date()
        rt.onReady = { [weak self] in
            guard let self, !self.rtWaitingLocal else { return }
            self.rtReady()
        }
        rt.onAudio = { [weak self] pcm in self?.input.playRealtime(pcm) }
        rt.onAudioDone = { [weak self] in self?.input.endRealtimeAudio() }
        rt.onUserSpeechStarted = { [weak self] in
            guard let self, self.input.speaking else { return }
            let played = self.input.interruptRealtime()
            self.rtSession?.truncate(playedMs: played)
        }
        rt.onUserText = { [weak self] t in
            guard let self else { return }
            self.chat.append(ChatLine(who: .user, text: t))
            XLog("[对话] 用户（实时）：%@", t)
            self.history.append(BrainTurn(role: "user", text: t))
        }
        rt.onAssistantText = { [weak self] t in
            guard let self else { return }
            self.chat.append(ChatLine(who: .xueren, text: t, note: "实时 \(self.rtModel == .full ? "GPT" : "GPT mini")"))
            self.rememberSpoken(t)
            XLog("[对话] 雪人（实时）：%@", t)
            self.history.append(BrainTurn(role: "assistant", text: t))
            if self.history.count > 16 { self.history.removeFirst(self.history.count - 16) }
        }
        rt.onToolCall = { [weak self] name, args in
            guard let self, let session = self.session else { return "{}" }
            self.configureSession()
            let out = session.tool(name, argsJSON: args, nowMs: self.nowMs)
            self.applyToolEvent(out)
            self.flushSpeech()
            return out
        }
        rt.onActivity = { [weak self] in self?.rtLastActivity = Date() }
        rt.onClosed = { [weak self] reason in self?.rtClosed(reason) }
        rt.connect(key: key, model: rtModel, voice: rtVoice, instructions: instructions, tools: tools)
        Task { await updateListening() }
    }

    // 一轮对话开始：text = 唤醒时本机已经听清的话（直接发文字）；greet = 只喊了“雪人”，让它打个招呼
    private func startRealtimeTurn(text: String?, greet: Bool) {
        rtWaitingLocal = false
        rtPendingText = text
        rtPendingGreet = greet
        rtFallbackText = text
        if rtSession == nil { ensureRealtime() }
        if rtSession?.ready == true { rtReady() }
    }

    private func rtReady() {
        guard let rt = rtSession else { return }
        rtFallbackText = nil
        // 之后的麦克风声音直接送云端（本机识别器暂停）
        input.realtimeTap.setSink { [weak rt] pcm in
            Task { @MainActor in rt?.appendAudio(pcm) }
        }
        rtStreaming = true
        rtWarmSince = nil
        rtActive = true
        if let t = rtPendingText { rt.sendUserText(t) }
        else if rtPendingGreet { rt.greet("用户刚喊了你的名字“雪人”。用一句很短、很自然的话回应，比如“我在，怎么了？”") }
        rtPendingText = nil
        rtPendingGreet = false
        rtLastActivity = Date()
    }

    private func rtClosed(_ reason: String?) {
        input.realtimeTap.setSink(nil)
        rtSession = nil
        rtActive = false
        rtStreaming = false
        rtWarmSince = nil
        input.stopSpeaking()
        if let reason {
            status = "实时语音断开：\(reason)"
            // 还没连上就断了：这句话交给 Claude / 离线规则处理
            if let t = rtFallbackText { rtFallbackText = nil; Task { await command(t) } }
        }
        Task { await updateListening() }
    }

    // 20 秒没人说话：挂断实时连接（按时长计费，省钱），回到喊“雪人”唤醒
    // 20 秒没人说话：停止送声音（不再计费），回到喊“雪人”唤醒，但连接再保持 5 分钟（下次唤醒不用等连接）
    private func rtIdleCheck() {
        guard let rt = rtSession, !input.speaking else { return }
        if !rt.ready {
            if Date().timeIntervalSince(rtLastActivity) > 8 { rt.close("连接超时") }
            return
        }
        if rtStreaming, Date().timeIntervalSince(rtLastActivity) > 20 {
            input.realtimeTap.setSink(nil)
            rtStreaming = false
            rtActive = false
            rtWarmSince = Date()
            XLog("[实时] 20 秒没人说话，停止送声音，连接保温 5 分钟")
            Task { await updateListening() }
        } else if let w = rtWarmSince, Date().timeIntervalSince(w) > 300 {
            rt.close()
        }
    }

    func endRealtime() { rtSession?.close() }

    // 查东西时先应的一声（换着说）
    private func fillerLine() -> String {
        let options: [String]
        switch replyLang {
        case "ja": options = ["ちょっと待ってね", "うん、調べるね", "見てみるね"]
        case "en": options = ["Let me check.", "One sec.", "Hang on, checking."]
        default: options = ["嗯，我看看", "好，我查一下", "等我一下，我看看路线"]
        }
        return options.randomElement()!
    }

    private func stopTalking() {
        input.stopSpeaking()
        speech.stop()
    }

    private func rememberSpoken(_ text: String) {
        recentSpoken.append(text)
        if recentSpoken.count > 6 { recentSpoken.removeFirst() }
    }

    private func isEcho(_ text: String) -> Bool {
        let t = Array(text.filter { !$0.isPunctuation && !$0.isWhitespace })
        guard t.count >= 4 else { return false }
        // 有回声消除时，用户复述雪人的话（“你知道怎么走吗”）不能被当成回声：
        // 只在刚说完 2 秒内、而且几乎一字不差时才算
        let strict = input.echoCancel
        if strict && Date().timeIntervalSince(lastSpeakEnd) > 2 { return false }
        let limit = strict ? 0.85 : 0.5
        for r in recentSpoken {
            let rs = String(r.filter { !$0.isPunctuation && !$0.isWhitespace })
            var covered = 0
            var i = 0
            while i + 3 <= t.count {
                if rs.contains(String(t[i..<i + 3])) { covered += 1 }
                i += 1
            }
            if Double(covered) / Double(max(1, t.count - 2)) > limit { return true }
        }
        return false
    }

    private func restartListening() async {
        if input.running { await input.stop(); listening = false }
        await updateListening()
    }

    // 只需要保留可能是命令的文字：喊过“雪人”，或者正在等用户说话
    private func shouldKeep(_ text: String) -> Bool {
        Date() < commandWindowUntil || (session?.hasWake(text) ?? false)
    }

    private func heard(_ text: String, lang: String) {
        partial = ""
        let acked = wakeAcked
        wakeAcked = false
        guard let session else { return }
        if isEcho(text) { XLog("[回声] 是雪人自己刚说的话，忽略：%@", text); return }
        let stripped = session.stripWake(text)
        let woke = session.hasWake(text)
        guard woke || Date() < commandWindowUntil else { XLog("[唤醒] 没听到唤醒词，忽略：%@", text); return } // 没喊“雪人”的话不理会
        if useRealtime && (woke || rtStreaming) {
            commandWindowUntil = .distantPast
            commandWindowOpen = false
            if !stripped.isEmpty { chat.append(ChatLine(who: .user, text: stripped)) }
            startRealtimeTurn(text: stripped.isEmpty ? nil : stripped, greet: stripped.isEmpty && !acked)
            return
        }
        if stripped.isEmpty {
            if !acked { reply("我在", note: "唤醒") }
            openCommandWindow(seconds: 8)
            return
        }
        // 没喊雪人、只是在等回答的时候，听到很短又听不懂的词（旁边的声音、残音）就不理会
        if !woke && stripped.count <= 3 && session.understandLocal(stripped).contains("\"intent\":\"unknown\"") {
            XLog("[唤醒] 等回答时听到的短词，忽略：%@", stripped)
            return
        }
        commandWindowUntil = .distantPast
        commandWindowOpen = false
        Task { await command(stripped, lang: lang) }
    }

    private func command(_ text: String, lang heardLang: String? = nil) async {
        guard let session else { return }
        let t0 = Date()
        // 雪人用用户这句话的语言回答
        replyLang = heardLang ?? talkLang
        chat.append(ChatLine(who: .user, text: text))
        XLog("[对话] 用户：%@", text)
        configureSession()
        var say = ""
        var awaiting = false
        var via = "离线规则"
        cloudStartedNav = false

        var streamed = false
        if brain.hasKey, let p = session.companionPrompt() {
            thinking = true
            var lineIndex: Int?
            let reply = await brain.converse(text: text, context: contextLine(), history: history, system: p.system, tools: p.tools,
                onToolStart: { [weak self] in
                    // 要查路线：先应一声，不让用户干等
                    guard let self else { return }
                    let f = self.fillerLine()
                    self.rememberSpoken(f)
                    self.speakOut(f, lang: self.replyLang)
                },
                onSentence: { [weak self] sentence in
                    // 边生成边说：一句一句念出来，对话气泡跟着长
                    guard let self else { return }
                    streamed = true
                    self.thinking = false
                    self.rememberSpoken(sentence)
                    self.speakOut(sentence, lang: SpeechService.languageOf(sentence, fallback: self.replyLang))
                    if let i = lineIndex, i < self.chat.count { self.chat[i].text += sentence }
                    else { self.chat.append(ChatLine(who: .xueren, text: sentence, note: "云端 \(self.cloudModel.short)")); lineIndex = self.chat.count - 1 }
                }) { [weak self] name, args in
                guard let self else { return "{}" }
                let out = session.tool(name, argsJSON: args, nowMs: self.nowMs)
                self.applyToolEvent(out)
                return out
            }
            thinking = false
            if let reply {
                say = reply
                via = "云端 \(cloudModel.short)"
                awaiting = reply.hasSuffix("？") || reply.hasSuffix("?") || reply.hasSuffix("か")
            }
        }
        if via == "离线规则" {
            let intentJSON = session.understandLocal(text)
            XLog("[雪人] %@ → %@（离线规则）", text, intentJSON)
            let r = session.converse(intentJSON: intentJSON, nowMs: nowMs)
            applyEvent(r.event)
            say = r.say
            awaiting = r.awaiting == true
        }
        history.append(BrainTurn(role: "user", text: text))
        if !say.isEmpty { history.append(BrainTurn(role: "assistant", text: say)) }
        if history.count > 16 { history.removeFirst(history.count - 16) }

        flushSpeech()
        XLog("[计时] 理解+回复用了 %.2f 秒（%@）", Date().timeIntervalSince(t0), via)
        if !say.isEmpty && !streamed { reply(say, note: via) }
        // 对话中：回复后一小段时间内不用再喊雪人，可以直接接着说（问了问题时更长）
        let speakSec = Double(say.count) / 4
        openCommandWindow(seconds: (awaiting ? 12 : 8) + speakSec)
        await updateListening()
        refresh()
    }

    // 云端工具执行后的副作用（开始 / 结束导航要启动或停止计时器）
    private func applyToolEvent(_ json: String) {
        guard let d = json.data(using: .utf8), let obj = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
              let ev = obj["event"] as? String else { return }
        if ev == "started" { cloudStartedNav = true }
        applyEvent(ev)
    }

    private func applyEvent(_ ev: String?) {
        switch ev {
        case "started": navStarted()
        case "stopped": navStopped()
        case "paused": paused = true; stopTalking()
        case "resumed": paused = false
        default: break
        }
    }

    private func contextLine() -> String {
        let s = snapshot
        let langName = ["zh": "中文", "ja": "日语", "en": "英语"][replyLang] ?? "中文"
        var parts = ["用户这句话用的是\(langName)", "雪场：\(info?.name ?? "")", "定位来源：\(mode.rawValue)", "当地时间：\(Date().formatted(date: .omitted, time: .shortened))"]
        if navigating {
            parts.append("正在导航（\(s?.stateZh ?? "")），用户可能正在滑行，回复要很短")
            if let n = s?.nextText { parts.append("下一条提示：\(n)") }
            if let v = s?.speed { parts.append("当前速度约 \(Int(v * 3.6)) km/h") }
        } else {
            parts.append("未在导航")
        }
        if runsToday > 0 { parts.append("今天已经滑完 \(runsToday) 趟") }
        return parts.joined(separator: "；")
    }

    // 到达目的地：总结这一趟（云端用人设说，离线用模板）
    private func arrived() async {
        runsToday += 1
        let minutes = max(1, Int(Date().timeIntervalSince(navStartedAt) / 60))
        let km = navPlanKm
        let top = Int(maxSpeed * 3.6)
        var text = "到啦！这趟\(String(format: "%.1f", km))公里，用了\(minutes)分钟\(top > 0 ? "，最快\(top)公里每小时" : "")。歇会儿还是再来一趟？"
        var via = "离线"
        if brain.hasKey, let session, let p = session.companionPrompt() {
            let event = "【事件】刚到达目的地。这一趟约 \(String(format: "%.1f", km)) 公里，用时约 \(minutes) 分钟，最高速度约 \(top) km/h，今天第 \(runsToday) 趟。用陪滑伙伴的口吻简短说一两句（祝贺/点评/关心），可以问下一步想干嘛。不要调用工具。"
            if let r = await brain.converse(text: event, context: contextLine(), history: history, system: p.system, tools: p.tools, tool: { _, _ in "{}" }) {
                text = r; via = "云端 \(cloudModel.short)"
            }
        }
        history.append(BrainTurn(role: "user", text: "（到达目的地）"))
        history.append(BrainTurn(role: "assistant", text: text))
        reply(text, note: via)
        openCommandWindow(seconds: 12 + Double(text.count) / 4)
        await updateListening()
    }

    private func reply(_ text: String, note: String? = nil) {
        chat.append(ChatLine(who: .xueren, text: text, note: note))
        XLog("[对话] 雪人（%@）：%@", note ?? "", text)
        rememberSpoken(text)
        speakOut(text, lang: SpeechService.languageOf(text, fallback: replyLang))
    }

    // MARK: - 导航

    private func navStarted() {
        paused = false
        navStartedAt = Date()
        maxSpeed = 0
        navPlanKm = (snapshotRemainingKm() ?? 0)
        if mode == .sim {
            startSimTimer()
        } else {
            location.start()
            if recordWhileNav && !recorder.recording { recorder.start() }
        }
    }

    private func navStopped() {
        simTimer?.invalidate(); simTimer = nil
        paused = false
        if recorder.recording && !testing { finishRecording() }
        updateLocation()
    }

    func stopNav() {
        simTimer?.invalidate(); simTimer = nil
        if navigating { session?.stop(nowMs: nowMs) }
        if recorder.recording && !testing { finishRecording() }
        paused = false
        stopTalking()
        refresh()
    }

    func togglePause() {
        guard let session, navigating else { return }
        if paused { session.resume(nowMs: nowMs); paused = false } else { session.pause(nowMs: nowMs); paused = true; stopTalking() }
        refresh()
    }

    func replay() {
        guard let text = session?.replayText(nowMs: nowMs) else { return }
        speakOut(text, lang: lang)
    }

    func simWrongBranch() { session?.simWrongBranch() }
    func simOutage() { session?.simOutage(seconds: 12) }

    // 真实 GPS 模式下一直定位（规划时要知道“从这里出发”）；模拟模式且没在测试时关掉
    private func updateLocation() {
        if mode == .gps && info?.allowRealGps == true || testing {
            if !location.running { location.start() }
        } else if location.running && !recorder.recording {
            location.stop()
        }
    }

    // MARK: - 锁屏测试 / 轨迹记录

    func startTest() {
        testing = true
        recorder.start()
        location.start()
        lastStatusReport = Date()
        gapAnnounced = false
        reply("开始锁屏测试。可以锁屏、放进口袋、放音乐。每五分钟报告一次定位情况，定位中断时会提醒。")
        Task { await updateListening() }
    }

    func stopTest() {
        testing = false
        finishRecording()
        let s = trackStats
        var msg = "测试结束：\(Int(s.durationSec / 60)) 分钟，\(s.points) 个定位点，最长中断 \(Int(s.maxGapSec)) 秒。"
        if let a = s.batteryStart, let b = s.batteryNow { msg += "电量 \(Int(a * 100))% → \(Int(b * 100))%。" }
        reply(msg)
        updateLocation()
    }

    private func finishRecording() {
        lastTrackFile = recorder.stop()
        trackStats = recorder.stats
    }

    // MARK: - 定时

    private var nowMs: Double { Date().timeIntervalSince1970 * 1000 }

    private func startSimTimer() {
        simTimer?.invalidate()
        simTimer = Timer.scheduledTimer(withTimeInterval: 1 / simSpeed, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.simTick() }
        }
    }

    private func simTick() {
        guard let session, !paused else { return }
        let r = session.simStep()
        flushSpeech()
        refresh()
        if r?.done == true { simTimer?.invalidate(); simTimer = nil }
    }

    // 前台和后台（定位在跑时 App 不会被挂起）都会走这里
    private func everySecond() {
        if rtSession != nil { rtIdleCheck() }
        if commandWindowOpen && Date() >= commandWindowUntil {
            commandWindowOpen = false
            Task { await updateListening() }
        }
        if mode == .gps && navigating { session?.tick(nowMs: nowMs); flushSpeech() }
        if recorder.recording { trackStats = recorder.stats }
        if testing { testTick() }
        refresh()
    }

    private func testTick() {
        if let gap = recorder.secondsSinceLastFix(), gap > 10 {
            if !gapAnnounced { gapAnnounced = true; reply("定位中断，已经 \(Int(gap)) 秒没有新位置。") }
        }
        if Date().timeIntervalSince(lastStatusReport) >= 300 {
            lastStatusReport = Date()
            let s = recorder.stats
            var msg = "定位正常，已记录 \(s.points) 个点，最长中断 \(Int(s.maxGapSec)) 秒"
            if let b = s.batteryNow { msg += "，电量 \(Int(b * 100))%" }
            reply(msg + "。")
        }
    }

    private func handle(_ loc: CLLocation) {
        if recorder.recording {
            if gapAnnounced, let gap = recorder.secondsSinceLastFix() {
                gapAnnounced = false
                reply("定位恢复，中断了 \(Int(gap)) 秒。")
            }
            recorder.add(loc)
        }
        guard let session, mode == .gps else { return }
        let speed: Double? = loc.speed >= 0 ? loc.speed : nil
        session.onLocation(tMs: loc.timestamp.timeIntervalSince1970 * 1000,
                           lat: loc.coordinate.latitude, lon: loc.coordinate.longitude,
                           acc: loc.horizontalAccuracy, speed: speed)
        if navigating {
            session.tick(nowMs: nowMs)   // 后台没有定时器时，靠定位回调发现中断
            flushSpeech()
        }
        refresh()
    }

    private func flushSpeech() {
        guard let session else { return }
        for item in session.drainSpeech() {
            // 云端雪人已经用自己的话说了“出发”，导航自带的“开始导航，前往…”就不再念
            if item.key == "start" && cloudStartedNav { cloudStartedNav = false; continue }
            chat.append(ChatLine(who: .system, text: item.text, note: item.reason))
            XLog("[播报] %@", item.text)
            if item.voice && !paused { rememberSpoken(item.text); speakOut(item.text, lang: lang) }
        }
        if chat.count > 200 { chat.removeFirst(chat.count - 200) }
    }

    private func refresh() {
        snapshot = session?.snapshot(nowMs: nowMs)
        let st = snapshot?.state ?? "idle"
        if let v = snapshot?.speed, navigating { maxSpeed = max(maxSpeed, v) }
        if st != lastNavState {
            if st == "arrived" {
                if mode == .gps && recorder.recording && !testing { finishRecording() }
                simTimer?.invalidate(); simTimer = nil
                Task { await arrived() }
            }
            lastNavState = st
        }
    }

    private func snapshotRemainingKm() -> Double? {
        guard let s = session?.snapshot(nowMs: nowMs) else { return nil }
        return s.remaining.map { $0 / 1000 } ?? s.routeKm
    }

    // MARK: - 开发

    func runSelfCheck() {
        guard let core else { return }
        let r = core.runSelfCheck()
        selfCheck = r
        XLog("[自检] %@", r.message)
        for (i, t) in r.actual.enumerated() { XLog("[自检] %02d %@", i + 1, t) }
    }

    func checkCapabilities() async {
        capabilities = await DeviceCapabilities.report()
        for line in capabilities { XLog("[能力] %@", line) }
    }
}
