// App 里的地图：真实雪场叠在卫星图上（Apple 地图），虚构演示雪场画示意图。
// 雪道按难度着色（绿 初级 / 红 中级 / 黑 高级），缆车白色虚线，推算的连接橙色点线，黄圈是岔口；
// 当前路线用青色加粗，蓝点是自己的位置（模拟或 GPS），闪烁的圈是下一个岔口。

import SwiftUI
import MapKit

struct MapScreen: View {
    let model: NavModel
    @Environment(\.dismiss) private var dismiss
    @State private var camera: MapCameraPosition = .automatic
    @State private var follow = false
    @State private var picked: MapEdge?

    var body: some View {
        NavigationStack {
            ZStack(alignment: .bottom) {
                if let data = model.mapData {
                    if data.geo { geoMap(data) } else { SchematicMap(data: data, state: model.mapState, picked: $picked) }
                } else {
                    ContentUnavailableView("没有地图数据", systemImage: "map")
                }
                bottomCard
            }
            .navigationTitle(model.info?.name ?? "地图")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("完成") { model.mapOpen = false; dismiss() } }
                if model.mapData?.geo == true {
                    ToolbarItem(placement: .topBarLeading) {
                        Button { follow.toggle(); if follow { centerOnMe() } } label: {
                            Image(systemName: follow ? "location.fill" : "location")
                        }
                        .accessibilityLabel(follow ? "停止跟随" : "跟随我的位置")
                    }
                }
            }
            .onChange(of: model.mapState?.pos ?? []) { if follow { centerOnMe() } }
            .onAppear { if model.navigating && model.mapData?.geo == true { follow = true; centerOnMe() } }
        }
    }

    private func centerOnMe() {
        guard let p = model.mapState?.pos, p.count == 2 else { return }
        withAnimation { camera = .camera(MapCamera(centerCoordinate: CLLocationCoordinate2D(latitude: p[0], longitude: p[1]), distance: 1200)) }
    }

    @ViewBuilder private func geoMap(_ data: MapData) -> some View {
        let route = Set(model.mapState?.route ?? [])
        Map(position: $camera) {
            ForEach(data.edges) { e in
                MapPolyline(coordinates: e.c.map { CLLocationCoordinate2D(latitude: $0[0], longitude: $0[1]) })
                    .stroke(MapStyleKit.color(e), style: MapStyleKit.stroke(e))
            }
            ForEach(data.edges.filter { route.contains($0.id) }) { e in
                MapPolyline(coordinates: e.c.map { CLLocationCoordinate2D(latitude: $0[0], longitude: $0[1]) })
                    .stroke(.cyan, style: StrokeStyle(lineWidth: 7, lineCap: .round, lineJoin: .round))
            }
            ForEach(Array(data.forks.enumerated()), id: \.offset) { _, f in
                Annotation("", coordinate: CLLocationCoordinate2D(latitude: f[0], longitude: f[1]), anchor: .center) {
                    Circle().strokeBorder(.yellow, lineWidth: 2.5).background(Circle().fill(.black.opacity(0.35))).frame(width: 13, height: 13)
                }
            }
            ForEach(Array(data.pois.filter { $0.kind == "restaurant" }.enumerated()), id: \.offset) { _, p in
                Marker(p.name, systemImage: "fork.knife", coordinate: CLLocationCoordinate2D(latitude: p.c[0], longitude: p.c[1])).tint(.orange)
            }
            if let n = model.mapState?.next, n.count == 2 {
                Annotation("下一个岔口", coordinate: CLLocationCoordinate2D(latitude: n[0], longitude: n[1]), anchor: .center) { NextForkRing() }
            }
            if let d = model.mapState?.dest, d.count == 2 {
                Marker("目的地", systemImage: "flag.checkered", coordinate: CLLocationCoordinate2D(latitude: d[0], longitude: d[1])).tint(.green)
            }
            if let p = model.mapState?.pos, p.count == 2 {
                Annotation("我", coordinate: CLLocationCoordinate2D(latitude: p[0], longitude: p[1]), anchor: .center) { MeDot() }
            }
        }
        .mapStyle(.hybrid(elevation: .realistic))
        .mapControls { MapCompass(); MapScaleView(); MapPitchToggle() }
        .onMapCameraChange(frequency: .onEnd) { _ in }
    }

    private var bottomCard: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let s = model.snapshot, model.navigating {
                Text(s.nextText ?? s.stateZh ?? "").font(.headline).lineLimit(2)
                if let d = s.distToNext { Text("距岔口 \(Int(d)) 米").font(.subheadline).foregroundStyle(.secondary) }
            } else if let e = picked {
                Text(e.n.isEmpty ? MapStyleKit.kindName(e) : e.n).font(.headline)
                Text(MapStyleKit.kindName(e) + (e.u == 1 ? " · 推算的连接，未核实" : "")).font(.subheadline).foregroundStyle(.secondary)
            } else {
                MapLegend()
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14))
        .padding(.horizontal, 12)
        .padding(.bottom, 8)
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
    @Binding var picked: MapEdge?

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
