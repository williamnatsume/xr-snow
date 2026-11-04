// 界面（最简版）：雪场 / 起点 / 目的地 / 偏好 → 规划 → 开始 / 暂停 / 结束；大字显示下一条指令、距离、定位状态。

import SwiftUI

struct ContentView: View {
    @State private var model = NavModel()

    var body: some View {
        NavigationStack {
            if let err = model.fatalError {
                ContentUnavailableView("无法载入导航核心", systemImage: "exclamationmark.triangle", description: Text(err))
            } else if model.navigating {
                NavigatingView(model: model)
            } else {
                SetupView(model: model)
            }
        }
    }
}

// MARK: - 设置与规划

struct SetupView: View {
    @Bindable var model: NavModel

    var body: some View {
        Form {
            Section {
                Picker("雪场", selection: $model.resortId) {
                    ForEach(model.resortIds, id: \.self) { id in
                        Text(id == "demo-fictional" ? "虚构演示雪场" : "神乐（OSM，未核实）").tag(id)
                    }
                }
                if let info = model.info, !info.disclaimer.isEmpty {
                    Text(info.disclaimer).font(.footnote).foregroundStyle(.secondary)
                }
                if let errs = model.info?.errors, !errs.isEmpty {
                    Text(errs.joined(separator: "\n")).foregroundStyle(.red)
                }
            }

            Section("路线") {
                Picker("起点", selection: $model.startNode) { placeOptions }
                Picker("目的地", selection: $model.goalNode) { placeOptions }
                Picker("难度上限", selection: $model.maxDifficulty) {
                    Text("初级").tag(1); Text("中级").tag(2); Text("高级").tag(3); Text("专家").tag(4)
                }
                Toggle("尽量避开平路", isOn: $model.avoidFlat)
                Toggle("优先短路线", isOn: $model.preferShort)
                Button("规划路线") { model.doPlan() }
            }

            if let plan = model.plan { PlanSection(plan: plan) }

            Section("导航") {
                Picker("定位来源", selection: $model.mode) {
                    ForEach(NavModel.Mode.allCases) { m in Text(m.rawValue).tag(m) }
                }
                .pickerStyle(.segmented)
                .disabled(model.info?.allowRealGps != true)
                if model.info?.allowRealGps != true {
                    Text("这个地图不允许真实 GPS 导航，只能用模拟器。").font(.footnote).foregroundStyle(.secondary)
                }
                if model.mode == .gps && model.needsAck {
                    Toggle("我知道地图数据未核实，开放状态未知，只作参考", isOn: $model.dataAck)
                }
                if model.mode == .sim {
                    Picker("模拟速度", selection: $model.simSpeed) {
                        Text("1×").tag(1.0); Text("5×").tag(5.0); Text("20×").tag(20.0)
                    }
                    .pickerStyle(.segmented)
                }
                Picker("播报语言", selection: $model.lang) {
                    Text("中文").tag("zh"); Text("日本語").tag("ja")
                }
                Toggle("语音播报", isOn: $model.voiceOn)
                Button("开始导航") { model.start() }
                    .bold()
                    .disabled(model.plan?.ok != true)
                if let s = model.status { Text(s).foregroundStyle(.orange) }
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
            }
        }
        .navigationTitle("雪人")
    }

    @ViewBuilder private var placeOptions: some View {
        ForEach(model.places) { p in Text(p.name).tag(p.node) }
    }
}

struct PlanSection: View {
    let plan: PlanResult

    var body: some View {
        Section("规划结果") {
            if plan.ok {
                HStack {
                    Text(String(format: "%.1f km", (plan.length ?? 0) / 1000))
                    Spacer()
                    Text(String(format: "约 %.0f 分钟", (plan.time ?? 0) / 60))
                    if let d = plan.maxDiffZh { Spacer(); Text("最难：\(d)") }
                }
                ForEach(plan.steps ?? []) { s in
                    Text("· \(s.label)  \(Int(s.length)) m").font(.callout)
                }
                ForEach(plan.warnings ?? [], id: \.self) { w in
                    Text(w).font(.footnote).foregroundStyle(.orange)
                }
            } else {
                Text(plan.reason ?? "无法规划").foregroundStyle(.red)
                ForEach(plan.hints ?? [], id: \.self) { h in Text(h).font(.footnote) }
            }
        }
    }
}

// MARK: - 导航中

struct NavigatingView: View {
    @Bindable var model: NavModel

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            let s = model.snapshot
            HStack {
                Text(model.paused ? "已暂停" : (s?.stateZh ?? "—")).font(.headline)
                if let u = s?.unreliable { Text(u).font(.headline).foregroundStyle(.orange) }
                Spacer()
                if let t = s?.simT { Text(String(format: "模拟 %d:%02d", Int(t / 1000) / 60, Int(t / 1000) % 60)).monospacedDigit() }
            }
            Text(s?.nextText ?? (s?.state == "arrived" ? "已到达" : "—"))
                .font(.system(size: 34, weight: .bold))
                .minimumScaleFactor(0.5)
                .frame(maxWidth: .infinity, alignment: .leading)
            HStack(spacing: 20) {
                Stat(title: "距下一个岔口", value: s?.distToNext.map { "\(Int($0)) m" } ?? "—")
                Stat(title: "剩余", value: s?.remaining.map { String(format: "%.1f km", $0 / 1000) } ?? "—")
                Stat(title: "速度", value: s?.speed.map { String(format: "%.0f km/h", $0 * 3.6) } ?? "—")
                Stat(title: "误差", value: s?.acc.map { "\(Int($0)) m" } ?? "—")
            }
            if let e = s?.edge { Text("所在：\(e)").font(.callout).foregroundStyle(.secondary) }
            if let st = model.status { Text(st).font(.footnote).foregroundStyle(.orange) }

            HStack {
                Button(model.paused ? "继续" : "暂停") { model.togglePause() }
                Button("重播") { model.replay() }
                Button(model.voiceOn ? "静音" : "取消静音") { model.voiceOn.toggle() }
                Spacer()
                Button("结束", role: .destructive) { model.stop() }
            }
            .buttonStyle(.bordered)

            if model.mode == .sim {
                HStack {
                    Picker("速度", selection: $model.simSpeed) {
                        Text("1×").tag(1.0); Text("5×").tag(5.0); Text("20×").tag(20.0)
                    }
                    .pickerStyle(.segmented)
                    Button("下个岔口走错") { model.simWrongBranch() }
                    Button("中断 12 秒") { model.simOutage() }
                }
                .buttonStyle(.bordered)
                .font(.footnote)
            }

            List(model.spoken) { line in
                VStack(alignment: .leading) {
                    Text("\(line.time)  \(line.text)")
                    if let r = line.reason { Text(r).font(.caption).foregroundStyle(.secondary) }
                }
            }
            .listStyle(.plain)
        }
        .padding()
        .navigationTitle("导航中")
        .navigationBarTitleDisplayMode(.inline)
    }
}

struct Stat: View {
    let title: String
    let value: String
    var body: some View {
        VStack(alignment: .leading) {
            Text(title).font(.caption).foregroundStyle(.secondary)
            Text(value).font(.title3.monospacedDigit())
        }
    }
}
