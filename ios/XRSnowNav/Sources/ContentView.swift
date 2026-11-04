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
            Text(model.hasKey ? "云端理解" : "离线理解")
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

    var body: some View {
        NavigationStack {
            Form {
                Section("雪场") {
                    Picker("雪场", selection: $model.resortId) {
                        ForEach(model.resortIds, id: \.self) { id in
                            Text(id == "demo-fictional" ? "虚构演示雪场" : "神乐（OSM，未核实）").tag(id)
                        }
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
                    Picker("说话语言", selection: $model.lang) {
                        Text("中文").tag("zh"); Text("日本語").tag("ja")
                    }
                    Toggle("语音播报", isOn: $model.voiceOn)
                    Toggle("随时喊“雪人”唤醒", isOn: $model.wakeWordOn)
                } header: { Text("说话") } footer: {
                    Text("开着唤醒时 App 会一直用 iPhone 麦克风听（屏幕顶部有橙色点），更费电；大风时可能听不清。关掉后用大按钮、操作按钮或 Siri（“和雪人说话”）。")
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
