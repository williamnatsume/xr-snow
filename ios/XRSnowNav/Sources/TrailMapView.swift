// 雪道图（3D）的界面部分：把 TrailMapScene 放进 SCNView，加上手势、名字标签，
// 以及会变的东西：当前路线、我的位置、下一个岔口、目的地。
// - 单指拖 = 转动，双指捏 = 缩放，双指拖 = 平移（SceneKit 自带的镜头控制）
// - 雪道和缆车的粗细跟着镜头远近重建，远看不会细得看不见，近看不会糊成一片
// - 标签是永远朝向镜头的小图片：被山挡住的、互相重叠的会自动藏起来
// - 点餐厅 / 缆车名字 → 选中，底部卡片出现“带我去这”

import SceneKit
import SwiftUI
import UIKit

struct TrailMapView: UIViewRepresentable {
    let data: MapData
    let state: MapStateDTO?
    let terrain: Terrain
    let follow: Bool
    @Binding var selected: String?

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> SCNView {
        let v = SCNView()
        v.antialiasingMode = .multisampling4X
        v.backgroundColor = UIColor(red: 0.84, green: 0.91, blue: 0.97, alpha: 1)
        v.allowsCameraControl = true
        v.isPlaying = true; v.preferredFramesPerSecond = 30      // 一直渲染：标签大小、岔口的“呼吸”每帧都要更新（按需渲染时场景装好后不会自己刷新）
        v.delegate = context.coordinator
        v.addGestureRecognizer(UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.tapped(_:))))
        let spinner = UIActivityIndicatorView(style: .large)
        spinner.startAnimating(); spinner.translatesAutoresizingMaskIntoConstraints = false
        v.addSubview(spinner)
        NSLayoutConstraint.activate([spinner.centerXAnchor.constraint(equalTo: v.centerXAnchor), spinner.centerYAnchor.constraint(equalTo: v.centerYAnchor)])
        context.coordinator.onSelect = { name in selected = name }
        context.coordinator.start(view: v, spinner: spinner, data: data, terrain: terrain)
        return v
    }

    func updateUIView(_ v: SCNView, context: Context) {
        context.coordinator.onSelect = { name in selected = name }
        context.coordinator.apply(state: state, follow: follow)
    }

    final class Coordinator: NSObject, SCNSceneRendererDelegate {
        private struct Label { let node: SCNNode; let pos: V3; let aspect: Float; let pt: Float }

        var onSelect: (String?) -> Void = { _ in }
        private weak var view: SCNView?
        private var map: TrailMapScene?
        private var labels: [Label] = []       // 按重要程度排好：前面的先占位置
        private var markers: [Label] = []      // 我、岔口、目的地：不参与避让，一直显示
        private let me = SCNNode(), fork = SCNNode(), dest = SCNNode()
        private let fovV: Float = 34
        private var screenScale: CGFloat = 3
        private let lineQueue = DispatchQueue(label: "trailmap.lines", qos: .userInitiated)

        // 只在主线程用
        private var state: MapStateDTO?
        private var follow = false, wasFollowing = false
        private var routeKey = ""
        private var lineScale: Float = 1.3
        private var followTarget: V3?
        // 只在渲染线程用
        private var lineBucket = Int.min
        private var frame = 0

        // MARK: 生成场景

        func start(view: SCNView, spinner: UIActivityIndicatorView, data: MapData, terrain: Terrain) {
            self.view = view
            screenScale = view.traitCollection.displayScale > 0 ? view.traitCollection.displayScale : 3
            let t0 = Date()
            DispatchQueue.global(qos: .userInitiated).async {
                let edges = data.edges.map { e -> TrailEdge in
                    let big = ["ゴンドラ", "ロープウェ", "gondola", "ropeway", "Gondola", "Ropeway"].contains { e.n.contains($0) }
                    return TrailEdge(id: e.id, kind: e.t == "lift" ? .lift : e.t == "connector" ? .connector : .run,
                                     name: e.n.isEmpty ? nil : e.n, difficulty: e.d, bigLift: e.t == "lift" && big,
                                     closed: e.closed == 1, uncertain: e.u == 1,
                                     pts: e.c.filter { $0.count == 2 }.map { terrain.xz(lat: $0[0], lon: $0[1]) })
                }.filter { $0.pts.count >= 2 }
                let map = TrailMapScene(terrain: terrain, edges: edges, stride: 2)
                XLog("[雪道图] 场景生成 %.1f 秒，树 %d 棵", Date().timeIntervalSince(t0), map.treeCount)
                DispatchQueue.main.async { [weak self] in
                    spinner.removeFromSuperview()
                    self?.install(map, data: data)
                }
            }
        }

        private func install(_ map: TrailMapScene, data: MapData) {
            guard let view else { return }
            self.map = map
            buildLabels(map, data: data)
            for (node, img, pt) in [(me, Self.dot(), Float(22)), (fork, Self.ring(), Float(36)), (dest, Self.pill("目的地", fill: .systemGreen, fg: .white, stroke: .white, symbol: "flag.checkered"), Float(26))] {
                let l = Self.billboard(node, image: img, pos: V3(), pt: pt, order: 2000)
                node.isHidden = true; markers.append(l); map.scene.rootNode.addChildNode(node)
            }
            // 下一个岔口的圈一直在“呼吸”
            fork.childNodes.first?.runAction(.repeatForever(.sequence([.scale(to: 1.3, duration: 0.8), .scale(to: 0.85, duration: 0.8)])))

            let cam = SCNCamera(); cam.fieldOfView = CGFloat(fovV); cam.zNear = 100; cam.zFar = 200_000
            let node = SCNNode(); node.camera = cam
            map.scene.rootNode.addChildNode(node)
            view.scene = map.scene; view.pointOfView = node
            let c = view.defaultCameraController
            c.interactionMode = .orbitTurntable; c.automaticTarget = false; c.inertiaEnabled = true
            c.worldUp = SCNVector3(0, 1, 0); c.minimumVerticalAngle = 6; c.maximumVerticalAngle = 85
            overview(animated: false)
            apply(state: state, follow: follow)
        }

        private var aspect: Float {
            guard let b = view?.bounds, b.height > 10 else { return 0.5 }
            return Float(b.width / b.height)
        }

        private func move(to f: (pos: V3, target: V3), animated: Bool) {
            guard let view, let pov = view.pointOfView, let map else { return }
            let dist = simd_distance(f.pos, f.target)
            SCNTransaction.begin(); SCNTransaction.animationDuration = animated ? 0.6 : 0
            pov.simdPosition = f.pos
            pov.simdLook(at: f.target, up: V3(0, 1, 0), localFront: V3(0, 0, -1))
            map.scene.fogStartDistance = CGFloat(max(dist * 1.6, 9000)); map.scene.fogEndDistance = CGFloat(max(dist * 4, 30000)); map.scene.fogDensityExponent = 1.4
            SCNTransaction.commit()
            view.defaultCameraController.target = SCNVector3(f.target.x, f.target.y, f.target.z)
        }

        /// 整个雪场的全景：从山脚看向山顶
        private func overview(animated: Bool) {
            guard let map else { return }
            let pts = map.edges.flatMap { $0.pts }.enumerated().filter { $0.offset % 3 == 0 }.map { map.world($0.element) }
            move(to: map.frame(points: pts, pitch: 30, fovV: fovV, aspect: aspect, bottomInset: 0.22), animated: animated)
        }

        // MARK: 会变的东西

        func apply(state: MapStateDTO?, follow: Bool) {
            self.state = state; self.follow = follow
            guard let map else { return }
            let pos = point(state?.pos, lift: 14)
            place(me, pos); place(fork, point(state?.next, lift: 14)); place(dest, point(state?.dest, lift: 30))

            let ids = state?.route ?? [], preview = state?.preview == true
            let key = (preview ? "P" : "R") + ids.joined(separator: ",")
            if key != routeKey {
                routeKey = key
                map.routeNode.geometry = map.routeGeometry(edgeIds: ids, preview: preview, scale: lineScale)
                if preview, !ids.isEmpty {   // 雪人刚规划的路线：镜头框住整条路线
                    let set = Set(ids)
                    let pts = map.edges.filter { set.contains($0.id) }.flatMap { $0.pts }.map { map.world($0) }
                    move(to: map.frame(points: pts, pitch: 32, fovV: fovV, aspect: aspect, bottomInset: 0.3), animated: true)
                }
            }
            if follow, let p = pos {
                if !wasFollowing || followTarget == nil {
                    var f = map.frame(points: [p], pitch: 34, fovV: fovV, aspect: aspect, bottomInset: 0.15)
                    f.pos = f.target + simd_normalize(f.pos - f.target) * 2600    // 跟随时离得近一点
                    move(to: f, animated: true)
                } else if let old = followTarget, let pov = view?.pointOfView, simd_distance(old, p) > 1 {
                    // 保持用户转好的角度和远近，只把镜头平移过去
                    SCNTransaction.begin(); SCNTransaction.animationDuration = 0.9
                    pov.simdPosition += p - old
                    SCNTransaction.commit()
                    view?.defaultCameraController.target = SCNVector3(p.x, p.y, p.z)
                }
                followTarget = p
            } else { followTarget = nil }
            wasFollowing = follow
        }

        private func point(_ c: [Double]?, lift: Float) -> V3? {
            guard let map, let c, c.count == 2 else { return nil }
            let p = map.terrain.xz(lat: c[0], lon: c[1])
            return map.terrain.inside(p) ? map.world(p, lift: lift) : nil
        }
        private func place(_ node: SCNNode, _ p: V3?) {
            node.isHidden = p == nil
            if let p { node.simdPosition = p }
        }

        @objc func tapped(_ g: UITapGestureRecognizer) {
            guard let view else { return }
            let hits = view.hitTest(g.location(in: view), options: [.searchMode: SCNHitTestSearchMode.all.rawValue, .ignoreHiddenNodes: true])
            let name = hits.lazy.compactMap { h -> String? in
                var n: SCNNode? = h.node
                while let cur = n { if let s = cur.name, s.hasPrefix("poi:") { return String(s.dropFirst(4)) }; n = cur.parent }
                return nil
            }.first
            onSelect(name)
        }

        // MARK: 每一帧（渲染线程）

        func renderer(_ renderer: SCNSceneRenderer, updateAtTime time: TimeInterval) {
            guard let map, let pov = renderer.pointOfView else { return }
            let cam = pov.presentation.simdWorldPosition, fwd = pov.presentation.simdWorldFront
            // 镜头离“正在看的那片地面”大概多远
            let ground = map.world(map.center).y
            let d = min(max((cam.y - ground) / max(0.2, -fwd.y), 500), 40000)
            pov.camera?.zNear = Double(max(20, d * 0.03))

            // 线的粗细：远近变了一档才重建
            let k = min(max(d / 9000, 0.3), 2.4)
            let bucket = Int((log2(k) / 0.4).rounded())
            if bucket != lineBucket {
                lineBucket = bucket
                let scale = powf(2, Float(bucket) * 0.4)
                DispatchQueue.main.async { [weak self] in self?.rebuildLines(scale) }
            }

            // 标签和标记：在屏幕上保持固定大小
            let vh = Float(renderer.currentViewport.height / screenScale)
            guard vh > 10 else { return }
            let unit = 2 * tan(fovV / 2 * .pi / 180) / vh       // 1 个屏幕点，在 1 米远处有多大
            for m in markers where !m.node.isHidden {
                let s = simd_distance(cam, m.node.presentation.simdWorldPosition) * unit * m.pt
                m.node.simdScale = V3(repeating: s)
            }
            frame += 1
            let declutter = frame % 6 == 1
            var taken: [CGRect] = []
            for l in labels {
                let dist = simd_distance(cam, l.pos)
                l.node.simdScale = V3(repeating: dist * unit * l.pt)
                guard declutter else { continue }
                let p = renderer.projectPoint(SCNVector3(l.pos.x, l.pos.y, l.pos.z))
                let w = CGFloat(l.pt * l.aspect), h = CGFloat(l.pt)
                let rect = CGRect(x: CGFloat(p.x) - w / 2, y: CGFloat(p.y) - h / 2, width: w, height: h)
                let vw = CGFloat(renderer.currentViewport.width / screenScale)
                var show = p.z > 0 && p.z < 1 && rect.minX > 2 && rect.maxX < vw - 2 && simd_dot(l.pos - cam, fwd) > 0 && map.visible(l.pos, from: cam)
                if show, taken.contains(where: { $0.insetBy(dx: -4, dy: -3).intersects(rect) }) { show = false }
                if show { taken.append(rect) }
                l.node.isHidden = !show
            }
        }

        private func rebuildLines(_ scale: Float) {
            guard let map else { return }
            lineScale = scale
            let ids = state?.route ?? [], preview = state?.preview == true
            lineQueue.async {
                let g = map.lineGeometry(scale: scale)
                let r = map.routeGeometry(edgeIds: ids, preview: preview, scale: scale)
                DispatchQueue.main.async { [weak self] in
                    guard let self, self.lineScale == scale else { return }
                    map.setLines(g); map.routeNode.geometry = r
                }
            }
        }

        // MARK: 标签

        private func buildLabels(_ map: TrailMapScene, data: MapData) {
            // 同名的路段合在一起，只标最长那段的中点；长的排前面
            var groups: [String: (len: Float, best: TrailEdge)] = [:]
            for e in map.edges where e.kind != .connector {
                guard let n = e.name else { continue }
                let key = (e.kind == .lift ? "L" : "R") + n, g = groups[key]
                groups[key] = ((g?.len ?? 0) + e.length, (g == nil || e.length > g!.best.length) ? e : g!.best)
            }
            var items: [(priority: Float, label: Label)] = []
            for g in groups.values {
                let c = resample(g.best.pts, step: 10); guard let name = g.best.name, !c.isEmpty else { continue }
                let isLift = g.best.kind == .lift
                let ink = UIColor(red: 0.10, green: 0.13, blue: 0.20, alpha: 1)
                let col = TrailMapStyle.runColor(g.best.difficulty, closed: g.best.closed)
                let img = isLift ? Self.pill(name, fill: .white, fg: ink, stroke: ink, symbol: "cablecar.fill")
                                 : Self.pill(name, fill: UIColor(red: CGFloat(col.x), green: CGFloat(col.y), blue: CGFloat(col.z), alpha: 1), fg: .white, stroke: .white, symbol: nil)
                let node = SCNNode()
                // 点缆车的名字 = 选中它的乘车处
                if isLift, let station = data.pois.first(where: { $0.kind == "lift-bottom" && $0.name.hasPrefix(name) }) { node.name = "poi:" + station.name }
                let l = Self.billboard(node, image: img, pos: map.world(c[c.count / 2], lift: isLift ? 45 : 20), pt: 21, order: 1000)
                items.append((g.len + (isLift ? 300 : 0), l))
            }
            for p in data.pois where p.kind == "restaurant" && p.c.count == 2 {
                let node = SCNNode(); node.name = "poi:" + p.name
                let img = Self.pill(p.name, fill: .systemOrange, fg: .white, stroke: .white, symbol: "fork.knife")
                items.append((100_000, Self.billboard(node, image: img, pos: map.world(map.terrain.xz(lat: p.c[0], lon: p.c[1]), lift: 40), pt: 21, order: 1001)))
            }
            labels = items.sorted { $0.priority > $1.priority }.map(\.label)
            for l in labels { l.node.isHidden = true; map.scene.rootNode.addChildNode(l.node) }
        }

        /// 一张永远朝向镜头的小图片。图片挂在子节点上，外层节点负责位置和大小
        private static func billboard(_ node: SCNNode, image: UIImage, pos: V3, pt: Float, order: Int) -> Label {
            let aspect = Float(image.size.width / max(image.size.height, 1))
            let plane = SCNPlane(width: CGFloat(aspect), height: 1)
            let m = SCNMaterial(); m.lightingModel = .constant; m.diffuse.contents = image; m.isDoubleSided = true
            m.readsFromDepthBuffer = false; m.writesToDepthBuffer = false      // 不被山挡住；该不该显示由我们自己判断
            plane.materials = [m]
            let inner = SCNNode(geometry: plane); inner.renderingOrder = order
            node.addChildNode(inner)
            node.constraints = [SCNBillboardConstraint()]
            node.simdPosition = pos
            return Label(node: node, pos: pos, aspect: aspect, pt: pt)
        }

        private static func pill(_ text: String, fill: UIColor, fg: UIColor, stroke: UIColor, symbol: String?) -> UIImage {
            let font = UIFont.systemFont(ofSize: 12, weight: .bold)
            let s = NSMutableAttributedString()
            if let symbol, let img = UIImage(systemName: symbol, withConfiguration: UIImage.SymbolConfiguration(pointSize: 10, weight: .bold))?.withTintColor(fg, renderingMode: .alwaysOriginal) {
                let a = NSTextAttachment(); a.image = img
                a.bounds = CGRect(x: 0, y: -1.5, width: img.size.width, height: img.size.height)
                s.append(NSAttributedString(attachment: a)); s.append(NSAttributedString(string: " "))
            }
            s.append(NSAttributedString(string: text, attributes: [.font: font, .foregroundColor: fg]))
            let ts = s.size(), size = CGSize(width: ceil(ts.width) + 16, height: 21)
            let f = UIGraphicsImageRendererFormat(); f.scale = 3
            return UIGraphicsImageRenderer(size: size, format: f).image { _ in
                let r = CGRect(origin: .zero, size: size).insetBy(dx: 1, dy: 1)
                let path = UIBezierPath(roundedRect: r, cornerRadius: r.height / 2)
                fill.setFill(); path.fill(); stroke.setStroke(); path.lineWidth = 1.5; path.stroke()
                s.draw(at: CGPoint(x: 8, y: (size.height - ts.height) / 2))
            }
        }
        private static func dot() -> UIImage {
            let f = UIGraphicsImageRendererFormat(); f.scale = 3
            return UIGraphicsImageRenderer(size: CGSize(width: 22, height: 22), format: f).image { _ in
                UIColor.white.setFill(); UIBezierPath(ovalIn: CGRect(x: 1, y: 1, width: 20, height: 20)).fill()
                UIColor.systemBlue.setFill(); UIBezierPath(ovalIn: CGRect(x: 4.5, y: 4.5, width: 13, height: 13)).fill()
            }
        }
        private static func ring() -> UIImage {
            let f = UIGraphicsImageRendererFormat(); f.scale = 3
            return UIGraphicsImageRenderer(size: CGSize(width: 36, height: 36), format: f).image { _ in
                let p = UIBezierPath(ovalIn: CGRect(x: 6, y: 6, width: 24, height: 24))
                UIColor.white.setStroke(); p.lineWidth = 6; p.stroke()
                UIColor.cyan.setStroke(); p.lineWidth = 3.5; p.stroke()
            }
        }
    }
}
