// App 里的地图：真实雪场叠在卫星图上（Apple 地图），虚构演示雪场画示意图。
// 雪道按难度着色（绿 初级 / 红 中级 / 黑 高级），缆车白色虚线，推算的连接橙色点线，黄圈是岔口；
// 当前路线用青色加粗（雪人刚规划、还没出发的是青色虚线），蓝点是自己，闪烁的圈是下一个岔口。
//
// 和雪人联动：
// - 说“看地图 / 关掉地图”打开收起；雪人规划出新路线时自动弹出预览，可以说“出发”或点按钮
// - 地图上有麦克风，看着地图也能和雪人说话；雪人说的话以字幕显示在上方
// - 点地图上的地点 →“带我去这”，交给雪人规划
// - 没在导航时底部显示“你在哪条雪道，往下多少米有岔口”（GPS）

import SwiftUI
import MapKit

struct MapScreen: View {
    let model: NavModel
    @Environment(\.dismiss) private var dismiss
    @State private var camera: MapCameraPosition = .automatic
    @State private var follow = false
    @State private var selected: String?

    var body: some View {
        NavigationStack {
            ZStack(alignment: .bottom) {
                if let data = model.mapData {
                    if data.geo { geoMap(data) } else { SchematicMap(data: data, state: model.mapState) }
                } else {
                    ContentUnavailableView("没有地图数据", systemImage: "map")
                }
                VStack(spacing: 10) {
                    HStack { Spacer(); micButton }
                    bottomCard
                }
                .padding(.bottom, 8)
            }
            .overlay(alignment: .top) { caption }
            .navigationTitle(model.info?.name ?? "地图")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("完成") { model.mapOpen = false; dismiss() } }
                if model.mapData?.geo == true && model.mapState?.pos != nil {
                    ToolbarItem(placement: .topBarLeading) {
                        Button { follow.toggle(); if follow { centerOnMe() } } label: {
                            Image(systemName: follow ? "location.fill" : "location")
                        }
                        .accessibilityLabel(follow ? "停止跟随" : "跟随我的位置")
                    }
                }
            }
            .onChange(of: model.mapState?.pos ?? []) { if follow { centerOnMe() } }
            .onChange(of: model.navigating) { if model.navigating && model.mapData?.geo == true { follow = true; centerOnMe() } }
            .onChange(of: model.mapState?.route ?? []) { if model.mapState?.preview == true { follow = false; fitRoute() } }
            .onAppear {
                if model.navigating && model.mapState?.pos != nil && model.mapData?.geo == true { follow = true; centerOnMe() }
                else if model.mapState?.preview == true { fitRoute() }
            }
        }
    }

    private func centerOnMe() {
        guard let p = model.mapState?.pos, p.count == 2 else { return }
        withAnimation { camera = .camera(MapCamera(centerCoordinate: CLLocationCoordinate2D(latitude: p[0], longitude: p[1]), distance: 1200)) }
    }

    // 预览路线：镜头框住整条路线
    private func fitRoute() {
        guard let data = model.mapData, data.geo, let ids = model.mapState?.route, !ids.isEmpty else { return }
        let set = Set(ids)
        let pts = data.edges.filter { set.contains($0.id) }.flatMap(\.c)
        guard let minLat = pts.map({ $0[0] }).min(), let maxLat = pts.map({ $0[0] }).max(),
              let minLon = pts.map({ $0[1] }).min(), let maxLon = pts.map({ $0[1] }).max() else { return }
        let region = MKCoordinateRegion(center: CLLocationCoordinate2D(latitude: (minLat + maxLat) / 2, longitude: (minLon + maxLon) / 2),
                                        span: MKCoordinateSpan(latitudeDelta: (maxLat - minLat) * 1.6 + 0.003, longitudeDelta: (maxLon - minLon) * 1.6 + 0.003))
        withAnimation { camera = .region(region) }
    }

    @ViewBuilder private func geoMap(_ data: MapData) -> some View {
        let st = model.mapState
        let route = Set(st?.route ?? [])
        let preview = st?.preview == true
        Map(position: $camera, selection: $selected) {
            ForEach(data.edges) { e in
                MapPolyline(coordinates: e.c.map { CLLocationCoordinate2D(latitude: $0[0], longitude: $0[1]) })
                    .stroke(MapStyleKit.color(e), style: MapStyleKit.stroke(e))
            }
            ForEach(data.edges.filter { route.contains($0.id) }) { e in
                MapPolyline(coordinates: e.c.map { CLLocationCoordinate2D(latitude: $0[0], longitude: $0[1]) })
                    .stroke(.cyan, style: preview ? StrokeStyle(lineWidth: 6, lineCap: .round, dash: [10, 7]) : StrokeStyle(lineWidth: 7, lineCap: .round, lineJoin: .round))
            }
            ForEach(Array(data.forks.enumerated()), id: \.offset) { _, f in
                Annotation("", coordinate: CLLocationCoordinate2D(latitude: f[0], longitude: f[1]), anchor: .center) {
                    Circle().strokeBorder(.yellow, lineWidth: 2.5).background(Circle().fill(.black.opacity(0.35))).frame(width: 13, height: 13)
                }
                .annotationTitles(.hidden)
            }
            ForEach(Array(data.pois.filter { $0.kind == "restaurant" }.enumerated()), id: \.offset) { _, p in
                Marker(p.name, systemImage: "fork.knife", coordinate: CLLocationCoordinate2D(latitude: p.c[0], longitude: p.c[1]))
                    .tint(.orange)
                    .tag(p.name)
            }
            // 缆车站：小图标，点一下能选（名字太多，平时不显示）
            ForEach(Array(data.pois.filter { $0.kind != "restaurant" }.enumerated()), id: \.offset) { _, p in
                Annotation(p.name, coordinate: CLLocationCoordinate2D(latitude: p.c[0], longitude: p.c[1]), anchor: .center) {
                    Image(systemName: "cablecar.fill").font(.system(size: 9, weight: .bold)).foregroundStyle(.white)
                        .frame(width: 18, height: 18).background(Circle().fill(.gray.opacity(0.85)))
                        .scaleEffect(selected == p.name ? 1.5 : 1)
                }
                .annotationTitles(.hidden)
                .tag(p.name)
            }
            if let n = st?.next, n.count == 2 {
                Annotation(model.navigating ? "下一个岔口" : "往下的岔口", coordinate: CLLocationCoordinate2D(latitude: n[0], longitude: n[1]), anchor: .center) { NextForkRing() }
            }
            if let d = st?.dest, d.count == 2 {
                Marker("目的地", systemImage: "flag.checkered", coordinate: CLLocationCoordinate2D(latitude: d[0], longitude: d[1])).tint(.green)
            }
            if let p = st?.pos, p.count == 2 {
                Annotation("我", coordinate: CLLocationCoordinate2D(latitude: p[0], longitude: p[1]), anchor: .center) { MeDot() }
            } else {
                UserAnnotation()   // 模拟模式没在导航：显示手机自己的定位
            }
        }
        .mapStyle(.hybrid(elevation: .realistic))
        .mapControls { MapUserLocationButton(); MapCompass(); MapScaleView(); MapPitchToggle() }
    }

    // 雪人刚说的话（或刚听到的话）：字幕显示 12 秒
    @ViewBuilder private var caption: some View {
        TimelineView(.periodic(from: .now, by: 1)) { ctx in
            if let line = model.chat.last(where: { $0.who != .system }), ctx.date.timeIntervalSince(line.at) < 12 {
                HStack(alignment: .top, spacing: 6) {
                    Image(systemName: line.who == .user ? "person.fill" : "snowflake").foregroundStyle(line.who == .user ? Color.secondary : Color.cyan)
                    Text(line.text).font(.subheadline).lineLimit(3)
                }
                .padding(.horizontal, 12).padding(.vertical, 8)
                .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
                .padding(.horizontal, 16).padding(.top, 6)
                .transition(.opacity)
            }
        }
    }

    private var micButton: some View {
        Button { model.talkButton() } label: {
            Image(systemName: model.listening ? "waveform" : "mic.fill")
                .font(.title2.weight(.semibold))
                .foregroundStyle(.white)
                .frame(width: 60, height: 60)
                .background(Circle().fill(model.listening ? Color.red : Color.blue))
                .shadow(radius: 3)
        }
        .accessibilityLabel("和雪人说话")
        .padding(.trailing, 16)
    }

    private var bottomCard: some View {
        let st = model.mapState
        return VStack(alignment: .leading, spacing: 8) {
            if let s = model.snapshot, model.navigating {
                Text(s.nextText ?? s.stateZh ?? "").font(.headline).lineLimit(2)
                if let d = s.distToNext { Text("距岔口 \(Int(d)) 米" + (st?.near.map { " · \($0)" } ?? "")).font(.subheadline).foregroundStyle(.secondary) }
            } else if st?.preview == true {
                Text("雪人规划的路线").font(.headline)
                Text([st?.km.map { String(format: "%.1f 公里", $0) }, st?.min.map { "约 \($0) 分钟" }].compactMap { $0 }.joined(separator: " · ") + "　说“出发”或点按钮")
                    .font(.subheadline).foregroundStyle(.secondary)
                HStack {
                    Button { model.mapConfirm(true) } label: { Label("出发", systemImage: "figure.skiing.downhill").frame(maxWidth: .infinity) }
                        .buttonStyle(.borderedProminent)
                    Button { model.mapConfirm(false) } label: { Text("不要").frame(maxWidth: .infinity) }
                        .buttonStyle(.bordered)
                }
            } else if let name = selected {
                Text(name).font(.headline)
                Button { let n = name; selected = nil; model.goTo(n) } label: { Label("带我去这", systemImage: "arrow.triangle.turn.up.right.circle.fill").frame(maxWidth: .infinity) }
                    .buttonStyle(.borderedProminent)
            } else if st?.far == true {
                Text("你现在不在这个雪场的地图范围里").font(.subheadline)
                MapLegend()
            } else if let near = st?.near {
                Text("你在 \(near)").font(.headline)
                if let d = st?.forkDist { Text("往下约 \(Int((d / 10).rounded()) * 10) 米有个岔口（闪烁的圈）").font(.subheadline).foregroundStyle(.secondary) }
            } else {
                MapLegend()
                Text("点地点可以让雪人带你去；也可以直接说“去山顶”").font(.caption).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14))
        .padding(.horizontal, 12)
    }
}

enum MapStyleKit {
    static func color(_ e: MapEdge) -> Color {
        if e.closed == 1 { return .gray }
        switch e.t {
        case "lift": return .white
        case "connector": return e.u == 1 ? .orange : .teal
        default:
            switch e.d { case 1: return .green; case 2: return .red; case 3, 4: return .black; default: return .gray }
        }
    }
    static func stroke(_ e: MapEdge) -> StrokeStyle {
        switch e.t {
        case "lift": return StrokeStyle(lineWidth: 2.5, dash: [8, 5])
        case "connector": return StrokeStyle(lineWidth: 3, lineCap: .round, dash: [1, 6])
        default: return StrokeStyle(lineWidth: 3.5, lineCap: .round, lineJoin: .round)
        }
    }
    static func kindName(_ e: MapEdge) -> String {
        switch e.t {
        case "lift": return "缆车"
        case "connector": return "步行连接"
        default: return ["", "初级雪道", "中级雪道", "高级雪道", "专家雪道"][min(max(e.d, 0), 4)].isEmpty ? "雪道" : ["", "初级雪道", "中级雪道", "高级雪道", "专家雪道"][min(max(e.d, 0), 4)]
        }
    }
}

struct MapLegend: View {
    var body: some View {
        HStack(spacing: 12) {
            legend(.green, "初级"); legend(.red, "中级"); legend(.black, "高级"); legend(.orange, "推算")
            HStack(spacing: 4) { Circle().strokeBorder(.yellow, lineWidth: 2).frame(width: 10, height: 10); Text("岔口") }
            HStack(spacing: 4) { Capsule().fill(.cyan).frame(width: 16, height: 5); Text("路线") }
        }
        .font(.caption)
    }
    private func legend(_ c: Color, _ t: String) -> some View {
        HStack(spacing: 4) { Capsule().fill(c).frame(width: 16, height: 4).overlay(Capsule().stroke(.white.opacity(0.6), lineWidth: 0.5)); Text(t) }
    }
}

struct MeDot: View {
    var body: some View {
        Circle().fill(.blue).frame(width: 16, height: 16).overlay(Circle().stroke(.white, lineWidth: 3)).shadow(radius: 2)
    }
}

struct NextForkRing: View {
    @State private var pulse = false
    var body: some View {
        Circle().stroke(.cyan, lineWidth: 3).frame(width: 28, height: 28)
            .scaleEffect(pulse ? 1.25 : 0.85).opacity(pulse ? 0.5 : 1)
            .onAppear { withAnimation(.easeInOut(duration: 0.9).repeatForever()) { pulse = true } }
    }
}

// 虚构演示雪场：局部米制坐标，画示意图
struct SchematicMap: View {
    let data: MapData
    let state: MapStateDTO?

    var body: some View {
        GeometryReader { geo in
            let all = data.edges.flatMap(\.c)
            let xs = all.map { $0[0] }, ys = all.map { $0[1] }
            let minX = xs.min() ?? 0, maxX = xs.max() ?? 1, minY = ys.min() ?? 0, maxY = ys.max() ?? 1
            let pad: CGFloat = 30
            let scale = min((geo.size.width - 2 * pad) / max(1, maxX - minX), (geo.size.height - 2 * pad - 90) / max(1, maxY - minY))
            let pt = { (p: [Double]) -> CGPoint in CGPoint(x: pad + (p[0] - minX) * scale, y: pad + (maxY - p[1]) * scale) }
            let route = Set(state?.route ?? [])
            Canvas { ctx, _ in
                for e in data.edges {
                    var path = Path(); path.addLines(e.c.map(pt))
                    ctx.stroke(path, with: .color(MapStyleKit.color(e) == .white ? .gray : MapStyleKit.color(e)), style: MapStyleKit.stroke(e))
                }
                for e in data.edges where route.contains(e.id) {
                    var path = Path(); path.addLines(e.c.map(pt))
                    ctx.stroke(path, with: .color(.cyan.opacity(0.85)), style: StrokeStyle(lineWidth: 7, lineCap: .round, lineJoin: .round))
                }
                for f in data.forks {
                    let c = pt(f)
                    ctx.stroke(Path(ellipseIn: CGRect(x: c.x - 6, y: c.y - 6, width: 12, height: 12)), with: .color(.yellow), lineWidth: 2.5)
                }
                for p in data.pois {
                    let c = pt(p.c)
                    ctx.draw(Text(p.name).font(.caption2).foregroundStyle(.secondary), at: CGPoint(x: c.x, y: c.y - 12))
                }
                if let n = state?.next, n.count == 2 {
                    let c = pt(n)
                    ctx.stroke(Path(ellipseIn: CGRect(x: c.x - 13, y: c.y - 13, width: 26, height: 26)), with: .color(.cyan), lineWidth: 3)
                }
                if let p = state?.pos, p.count == 2 {
                    let c = pt(p)
                    ctx.fill(Path(ellipseIn: CGRect(x: c.x - 8, y: c.y - 8, width: 16, height: 16)), with: .color(.blue))
                    ctx.stroke(Path(ellipseIn: CGRect(x: c.x - 8, y: c.y - 8, width: 16, height: 16)), with: .color(.white), lineWidth: 3)
                }
            }
            .background(Color(.secondarySystemBackground))
        }
        .overlay(alignment: .top) {
            Text("虚构演示雪场（示意图）").font(.caption).padding(6).background(.thinMaterial, in: Capsule()).padding(.top, 8)
        }
    }
}
