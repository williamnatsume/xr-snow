// 界面：以说话为主。大按钮 = 直接说（不用喊“雪人”）；开着唤醒词时随时喊“雪人”。
// 设置（雪场、定位来源、云端密钥、锁屏测试、开发）放在齿轮里。

import SwiftUI

struct ContentView: View {
    @State private var model = NavModel()
    @State private var showSettings = false
    @State private var typing = false
    @State private var typed = ""

    var body: some View {
        NavigationStack {
            if let err = model.fatalError {
                ContentUnavailableView("无法载入导航核心", systemImage: "exclamationmark.triangle", description: Text(err))
            } else {
                VStack(spacing: 0) {
                    StatusBar(model: model)
                    if model.navigating { NavCard(model: model) }
                    ChatList(model: model)
                    BottomBar(model: model, typing: $typing, typed: $typed)
                }
                .navigationTitle("雪人")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button { showSettings = true } label: { Image(systemName: "gearshape") }
                    }
                }
                .sheet(isPresented: $showSettings) { SettingsView(model: model) }
            }
        }
    }
}

// MARK: - 顶部状态

struct StatusBar: View {
    let model: NavModel
    var body: some View {
        HStack(spacing: 8) {
            Text(model.info?.name ?? "").lineLimit(1)
            Text("·")
            Text(model.mode.rawValue)
            Text("·")
            Text(model.rtActive ? "实时对话中" : model.useRealtime ? "实时语音" : model.hasKey ? "云端理解" : "离线理解")
                .foregroundStyle(model.rtActive ? .green : .secondary)
            Spacer()
            if model.testing { Label("测试中", systemImage: "record.circle").foregroundStyle(.red) }
            if model.listening {
                Label(model.wakeWordOn && !model.commandWindowOpen ? "喊“雪人”" : "在听", systemImage: "waveform")
                    .foregroundStyle(model.commandWindowOpen ? .green : .secondary)
            }
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .padding(.horizontal)
        .padding(.vertical, 6)
    }
}

// MARK: - 导航卡片

struct NavCard: View {
    @Bindable var model: NavModel
    var body: some View {
        let s = model.snapshot
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(model.paused ? "已暂停" : (s?.stateZh ?? "—")).font(.subheadline.bold())
                if let u = s?.unreliable { Text(u).font(.subheadline).foregroundStyle(.orange) }
                Spacer()
                if let t = s?.simT { Text(String(format: "模拟 %d:%02d", Int(t / 1000) / 60, Int(t / 1000) % 60)).font(.caption).monospacedDigit() }
            }
            Text(s?.nextText ?? (s?.state == "arrived" ? "已到达" : "—"))
                .font(.title2.bold())
                .minimumScaleFactor(0.6)
                .lineLimit(3)
            HStack(spacing: 16) {
                Stat(title: "距岔口", value: s?.distToNext.map { "\(Int($0)) m" } ?? "—")
                Stat(title: "剩余", value: s?.remaining.map { String(format: "%.1f km", $0 / 1000) } ?? "—")
                Stat(title: "速度", value: s?.speed.map { String(format: "%.0f km/h", $0 * 3.6) } ?? "—")
                Stat(title: "误差", value: s?.acc.map { "\(Int($0)) m" } ?? "—")
            }
            HStack {
                Button(model.paused ? "继续" : "暂停") { model.togglePause() }
                Button("重播") { model.replay() }
                if model.mode == .sim {
                    Button("走错") { model.simWrongBranch() }
                    Button("断 12 秒") { model.simOutage() }
                }
                Spacer()
                Button("结束", role: .destructive) { model.stopNav() }
            }
            .buttonStyle(.bordered)
            .font(.footnote)
        }
        .padding()
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 16))
        .padding(.horizontal)
    }
}

struct Stat: View {
    let title: String
    let value: String
    var body: some View {
        VStack(alignment: .leading) {
            Text(title).font(.caption2).foregroundStyle(.secondary)
            Text(value).font(.callout.monospacedDigit())
        }
    }
}

// MARK: - 对话记录

struct ChatList: View {
    let model: NavModel
    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 8) {
                    if model.chat.isEmpty {
                        Text(model.wakeWordOn
                             ? "喊“雪人”，或者按下面的按钮，说出你想去的地方。\n比如：去山脚餐厅，不走高级道。"
                             : "按下面的按钮，说出你想去的地方。\n比如：去山脚餐厅，不走高级道。")
                            .foregroundStyle(.secondary)
                            .padding(.top, 40)
                            .frame(maxWidth: .infinity)
                            .multilineTextAlignment(.center)
                    }
                    ForEach(model.chat) { line in Bubble(line: line).id(line.id) }
                    if !model.partial.isEmpty {
                        Text(model.partial).foregroundStyle(.secondary).italic().id("partial")
                    }
                    if model.thinking { ProgressView().id("thinking") }
                }
                .padding()
            }
            .onChange(of: model.chat.count) {
                if let last = model.chat.last { withAnimation { proxy.scrollTo(last.id, anchor: .bottom) } }
            }
        }
    }
}

struct Bubble: View {
    let line: ChatLine
    var body: some View {
        HStack {
            if line.who == .user { Spacer(minLength: 40) }
            VStack(alignment: line.who == .user ? .trailing : .leading, spacing: 2) {
                Text(line.text)
                    .padding(.horizontal, 12).padding(.vertical, 8)
                    .background(background, in: RoundedRectangle(cornerRadius: 14))
                    .foregroundStyle(line.who == .user ? .white : .primary)
                if let n = line.note { Text(n).font(.caption2).foregroundStyle(.secondary) }
            }
            if line.who != .user { Spacer(minLength: 40) }
        }
    }
    private var background: Color {
        switch line.who {
        case .user: return .blue
        case .xueren: return Color(.secondarySystemBackground)
        case .system: return Color.orange.opacity(0.15)
        }
    }
}

// MARK: - 底部：说话按钮

struct BottomBar: View {
    let model: NavModel
    @Binding var typing: Bool
    @Binding var typed: String
    var body: some View {
        VStack(spacing: 8) {
            if typing {
                HStack {
                    TextField("输入要说的话", text: $typed)
                        .textFieldStyle(.roundedBorder)
                        .onSubmit { model.submitText(typed); typed = "" }
                    Button("发送") { model.submitText(typed); typed = "" }
                }
            }
            HStack(alignment: .center) {
                Button { typing.toggle() } label: { Image(systemName: "keyboard").font(.title2) }
                    .frame(width: 60)
                    .accessibilityLabel("打字")
                Spacer()
                Button { model.talkButton() } label: {
                    ZStack {
                        Circle().fill(model.commandWindowOpen ? Color.green : Color.blue).frame(width: 96, height: 96)
                        Image(systemName: "mic.fill").font(.system(size: 40)).foregroundStyle(.white)
                    }
                }
                .accessibilityLabel("和雪人说话")
                Spacer()
                Color.clear.frame(width: 60, height: 1)
            }
        }
        .padding()
        .background(.bar)
    }
}

// MARK: - 设置

struct SettingsView: View {
    @Bindable var model: NavModel
    @Environment(\.dismiss) private var dismiss
    @State private var keyInput = ""
    @State private var openAIKeyInput = ""

    var body: some View {
        NavigationStack {
            Form {
                Section("雪场") {
                    Picker("雪场", selection: $model.resortId) {
                        ForEach(model.resortChoices, id: \.0) { r in Text(r.1).tag(r.0) }
                    }
                    if let q = model.mapQuality {
                        Text("地图质量：\(q.summary)").font(.footnote).foregroundStyle(.secondary)
                    }
                    if let info = model.info, !info.disclaimer.isEmpty {
                        Text(info.disclaimer).font(.footnote).foregroundStyle(.secondary)
                    }
                    Picker("定位来源", selection: $model.mode) {
                        ForEach(NavModel.Mode.allCases) { m in Text(m.rawValue).tag(m) }
                    }
                    .disabled(model.info?.allowRealGps != true)
                    if model.mode == .sim {
                        Picker("模拟时的出发地", selection: $model.simStartNode) {
                            ForEach(model.places) { p in Text(p.name).tag(p.node) }
                        }
                        Picker("模拟速度", selection: $model.simSpeed) {
                            Text("1×").tag(1.0); Text("5×").tag(5.0); Text("20×").tag(20.0)
                        }
                        .pickerStyle(.segmented)
                    } else if model.needsAck {
                        Toggle("我知道地图数据未核实，开放状态未知，只作参考", isOn: $model.dataAck)
                    }
                }

                Section {
                    Toggle("到雪场时自动下载地图", isOn: $model.autoMapDownload)
                    Button(model.mapBusy ? "处理中…" : "找我附近的雪场") { Task { await model.findNearby() } }
                        .disabled(model.mapBusy)
                    ForEach(model.nearbyAreas) { a in
                        Button("下载：\(a.name)（\(a.inside ? "就在这里" : "\(Int(a.dist_m / 1000)) 公里外")）") {
                            Task { await model.downloadArea(a) }
                        }.disabled(model.mapBusy)
                    }
                    DisclosureGroup("测试：按名字找日本的雪场") {
                        ForEach(MapPresets.japan, id: \.0) { p in
                            Button(p.0) { Task { await model.findNearby(lat: p.1, lon: p.2) } }.disabled(model.mapBusy)
                        }
                    }
                    if model.resortId.hasPrefix("osm-") {
                        Button("删除当前下载的地图", role: .destructive) { model.deleteDownloaded(model.resortId) }
                    }
                    if let s = model.mapStatus { Text(s).font(.footnote).foregroundStyle(.secondary) }
                } header: { Text("雪场地图（OpenStreetMap）") } footer: {
                    Text("地图来自 OpenStreetMap 社区（© OpenStreetMap contributors，ODbL），海拔来自国土地理院（日本）或 Open-Meteo。数据未经核实，开放状态未知，请以现场路牌为准。下载后离线可用。")
                }

                Section {
                    Picker("我说的语言", selection: $model.talkLang) {
                        Text("中文").tag("zh"); Text("日本語").tag("ja"); Text("English").tag("en")
                    }
                    Picker("同时听的第二语言", selection: $model.secondLang) {
                        Text("日本語").tag("ja"); Text("English").tag("en"); Text("中文").tag("zh")
                    }
                    Picker("导航播报语言", selection: $model.lang) {
                        Text("中文").tag("zh"); Text("日本語").tag("ja")
                    }
                    Toggle("语音播报", isOn: $model.voiceOn)
                    Picker("雪人的声音", selection: $model.voiceId) {
                        Text("自动（用音质最好的）").tag("")
                        ForEach(model.zhVoices, id: \.0) { v in Text(v.1).tag(v.0) }
                    }
                    Button("试听") { model.previewVoice() }
                    Toggle("随时喊“雪人”唤醒", isOn: $model.wakeWordOn)
                } header: { Text("说话") } footer: {
                    Text("想让声音更像真人：iPhone 设置 → 辅助功能 → 朗读内容 → 声音 → 中文（中国大陆），下载标着“高级”或“增强”的声音（几百 MB），回来在这里选。iPhone 一次最多同时识别两种语言；雪人用你说话的语言回答。神乐的雪道名是日文假名，中文语音念不出来，所以神乐的转弯播报默认用日语；你说话和雪人回话仍然用中文。开着唤醒时 App 会一直用 iPhone 麦克风听（屏幕顶部有橙色点），更费电；大风时可能听不清。关掉后用大按钮、操作按钮或 Siri（“和雪人说话”）。")
                }

                Section {
                    Toggle("实时语音对话", isOn: $model.realtimeOn)
                    if model.hasOpenAIKey {
                        Label("已保存 OpenAI 密钥", systemImage: "checkmark.seal").foregroundStyle(.green)
                        Button("删除 OpenAI 密钥", role: .destructive) { model.setOpenAIKey("") }
                    } else {
                        SecureField("OpenAI API 密钥（sk-…）", text: $openAIKeyInput)
                        Button("保存") { model.setOpenAIKey(openAIKeyInput); openAIKeyInput = "" }.disabled(openAIKeyInput.isEmpty)
                    }
                    Picker("模型", selection: $model.rtModel) {
                        ForEach(RealtimeModel.allCases) { m in Text(m.label).tag(m) }
                    }
                    Picker("声音", selection: $model.rtVoice) {
                        ForEach(["marin", "cedar", "coral", "sage", "shimmer", "ballad", "alloy", "ash", "echo", "verse"], id: \.self) { v in
                            Text(v == "marin" || v == "cedar" ? "\(v)（推荐）" : v).tag(v)
                        }
                    }
                } header: { Text("实时语音（OpenAI）") } footer: {
                    Text("开着并且有密钥时：喊“雪人”后直接和 AI 语音对话（像打电话，可以随时插话），20 秒没人说话自动挂断，按时长计费。没网或失败时自动改用下面的 Claude / 离线理解。转弯播报始终由本机导航负责。")
                }

                Section {
                    if model.hasKey {
                        Label("已保存 API 密钥", systemImage: "checkmark.seal").foregroundStyle(.green)
                        Button("删除密钥", role: .destructive) { model.setKey("") }
                    } else {
                        SecureField("Anthropic API 密钥（sk-ant-…）", text: $keyInput)
                        Button("保存") { model.setKey(keyInput); keyInput = "" }.disabled(keyInput.isEmpty)
                    }
                    Picker("模型", selection: $model.cloudModel) {
                        ForEach(CloudModel.allCases) { m in Text(m.label).tag(m) }
                    }
                } header: { Text("云端理解（Claude）") } footer: {
                    Text("有密钥且联网时，用 Claude 理解你说的话；没网或失败时自动用离线规则。路线始终由本机地图规划。密钥只存在本机钥匙串。")
                }

                Section {
                    Toggle("导航时记录轨迹（真实 GPS）", isOn: $model.recordWhileNav)
                    if model.testing {
                        Text("已记录 \(model.trackStats.points) 点，最长中断 \(Int(model.trackStats.maxGapSec)) 秒")
                        Button("结束锁屏测试", role: .destructive) { model.stopTest() }
                    } else {
                        Button("开始锁屏测试") { model.startTest(); dismiss() }
                    }
                    if let f = model.lastTrackFile {
                        ShareLink(item: f) { Label("导出上次的 GPX：\(f.lastPathComponent)", systemImage: "square.and.arrow.up") }
                    }
                } header: { Text("轨迹 / 锁屏测试") } footer: {
                    Text("锁屏测试：只定位和记录，不导航。可以锁屏、放口袋、放音乐，每 5 分钟语音报告一次；定位中断超过 10 秒会提醒。")
                }

                Section("开发") {
                    Button("M1 自检（与 npm test 场景对比）") { model.runSelfCheck() }
                    if let r = model.selfCheck {
                        Label(r.message, systemImage: r.passed ? "checkmark.circle.fill" : "xmark.octagon.fill")
                            .foregroundStyle(r.passed ? .green : .red)
                    }
                    ForEach(model.capabilities, id: \.self) { line in
                        Text(line).font(.footnote).foregroundStyle(.secondary)
                    }
                    if let s = model.status { Text(s).font(.footnote).foregroundStyle(.orange) }
                }
            }
            .navigationTitle("设置")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
        }
    }
}

// 在家测试下载用：日本几个大雪场的大概位置
enum MapPresets {
    static let japan: [(String, Double, Double)] = [
        ("かぐら（神乐）", 36.866, 138.757),
        ("苗場", 36.791, 138.780),
        ("GALA湯沢", 36.951, 138.800),
        ("野沢温泉", 36.922, 138.625),
        ("志賀高原", 36.770, 138.510),
        ("白馬八方尾根", 36.700, 137.830),
        ("ニセコ グラン・ヒラフ", 42.862, 140.700),
        ("ルスツ", 42.750, 140.880)
    ]
}
