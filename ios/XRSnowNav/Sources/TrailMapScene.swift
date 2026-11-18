// 雪道图风格的 3D 地图场景（SceneKit）：真实地形 + 我们自己的雪道 / 缆车数据，画成官方雪道图那种样子。
// - 地形高度来自 Resources/terrain/<雪场 id>.terrain.*（tools/fetch-terrain.mjs 生成，出典：国土地理院）
// - 光照是自己算好写进顶点颜色的（材质用 constant），所以是“手绘图”那种固定的明暗，不随视角变
// - 雪道以外的地方整体压灰：不是雪道，按“不要进去”来画（官方的禁止区域我们没有数据，不画成“官方禁止”）
// - 树只是示意（按海拔 / 坡度随机撒），不是实际的树林分布
// 只用 Foundation / SceneKit / CoreGraphics（不碰 UIKit）；界面和手势在 TrailMapView.swift。
import CoreGraphics
import Foundation
import SceneKit
import simd

typealias V2 = SIMD2<Float>
typealias V3 = SIMD3<Float>

// MARK: - 地形

struct Terrain {
    let cols: Int, rows: Int
    let south: Double, west: Double, north: Double, east: Double
    let h: [Float]                 // 米，按行从北到南，每行从西到东
    let width: Float, depth: Float // 米（东西 / 南北）
    let mLat: Double, mLon: Double
    let minH: Float, maxH: Float

    init?(metaURL: URL, binURL: URL) {
        guard let md = try? Data(contentsOf: metaURL), let d = try? Data(contentsOf: binURL),
              let m = (try? JSONSerialization.jsonObject(with: md)) as? [String: Any],
              let cols = m["cols"] as? Int, let rows = m["rows"] as? Int,
              let south = m["south"] as? Double, let west = m["west"] as? Double,
              let north = m["north"] as? Double, let east = m["east"] as? Double,
              let unit = m["unit"] as? Double, d.count == cols * rows * 2, cols > 2, rows > 2 else { return nil }
        self.cols = cols; self.rows = rows; self.south = south; self.west = west; self.north = north; self.east = east
        h = d.withUnsafeBytes { raw in raw.bindMemory(to: Int16.self).map { Float(Int16(littleEndian: $0)) * Float(unit) } }
        mLat = 110540; mLon = 111320 * cos((south + north) / 2 * .pi / 180)
        width = Float((east - west) * mLon); depth = Float((north - south) * mLat)
        minH = h.min() ?? 0; maxH = h.max() ?? 0
    }

    /// App 包里有没有这个雪场的地形（目前只有内置的神乐）
    static func bundled(_ resortId: String) -> Terrain? {
        guard let j = Bundle.main.url(forResource: resortId + ".terrain", withExtension: "json"),
              let b = Bundle.main.url(forResource: resortId + ".terrain", withExtension: "bin") else { return nil }
        return Terrain(metaURL: j, binURL: b)
    }

    /// 经纬度 → 本地米制坐标：x 向东，y 向南，原点在范围中心
    func xz(lat: Double, lon: Double) -> V2 {
        V2(Float((lon - west) * mLon) - width / 2, Float((north - lat) * mLat) - depth / 2)
    }
    func inside(_ p: V2) -> Bool { abs(p.x) <= width / 2 && abs(p.y) <= depth / 2 }

    /// 双线性插值的真实高度（米）
    func height(_ p: V2) -> Float {
        let fx = min(max((p.x + width / 2) / width * Float(cols - 1), 0), Float(cols - 1) - 0.001)
        let fy = min(max((p.y + depth / 2) / depth * Float(rows - 1), 0), Float(rows - 1) - 0.001)
        let ix = Int(fx), iy = Int(fy); let ax = fx - Float(ix), ay = fy - Float(iy)
        let a = h[iy * cols + ix], b = h[iy * cols + ix + 1], c = h[(iy + 1) * cols + ix], d = h[(iy + 1) * cols + ix + 1]
        return a * (1 - ax) * (1 - ay) + b * ax * (1 - ay) + c * (1 - ax) * ay + d * ax * ay
    }
    /// 真实坡度方向（dh/dx, dh/dz）
    func gradient(_ p: V2) -> V2 {
        let e: Float = 20
        return V2(height(p + V2(e, 0)) - height(p - V2(e, 0)), height(p + V2(0, e)) - height(p - V2(0, e))) / (2 * e)
    }
}

// MARK: - 地图要素

struct TrailEdge {
    enum Kind { case run, lift, connector }
    let id: String
    let kind: Kind
    let name: String?
    let difficulty: Int          // 0 = 未知
    let bigLift: Bool            // 索道 / 吊厢：画粗、画红
    let closed: Bool
    let uncertain: Bool          // 程序推算出来的连接（未核实）
    let pts: [V2]
    var length: Float { zip(pts, pts.dropFirst()).reduce(0) { $0 + simd_distance($1.0, $1.1) } }
}

// MARK: - 小工具

/// 把顶点、颜色、三角形攒起来，最后一次生成一个几何体
final class MeshBuilder {
    var pos: [Float] = [], col: [Float] = [], idx: [UInt32] = []
    var count: UInt32 { UInt32(pos.count / 3) }
    @discardableResult func add(_ p: V3, _ c: V3, alpha: Float = 1) -> UInt32 {
        // SceneKit 把顶点颜色当线性值：这里从 sRGB 换算过去，颜色才和设计的一样
        pos.append(p.x); pos.append(p.y); pos.append(p.z)
        col.append(powf(max(c.x, 0), 2.2)); col.append(powf(max(c.y, 0), 2.2)); col.append(powf(max(c.z, 0), 2.2)); col.append(alpha)
        return count - 1
    }
    func tri(_ a: UInt32, _ b: UInt32, _ c: UInt32) { idx.append(a); idx.append(b); idx.append(c) }
    func quad(_ a: V3, _ b: V3, _ c: V3, _ d: V3, _ color: V3) {
        let i = add(a, color); add(b, color); add(c, color); add(d, color)
        tri(i, i + 1, i + 2); tri(i, i + 2, i + 3)
    }
    func geometry() -> SCNGeometry {
        let p = SCNGeometrySource(data: pos.withUnsafeBufferPointer { Data(buffer: $0) }, semantic: .vertex, vectorCount: pos.count / 3,
                                  usesFloatComponents: true, componentsPerVector: 3, bytesPerComponent: 4, dataOffset: 0, dataStride: 12)
        let c = SCNGeometrySource(data: col.withUnsafeBufferPointer { Data(buffer: $0) }, semantic: .color, vectorCount: col.count / 4,
                                  usesFloatComponents: true, componentsPerVector: 4, bytesPerComponent: 4, dataOffset: 0, dataStride: 16)
        let e = SCNGeometryElement(data: idx.withUnsafeBufferPointer { Data(buffer: $0) }, primitiveType: .triangles,
                                   primitiveCount: idx.count / 3, bytesPerIndex: 4)
        let g = SCNGeometry(sources: [p, c], elements: [e])
        let m = SCNMaterial()
        m.lightingModel = .constant; m.isDoubleSided = true
        m.diffuse.contents = CGColor(red: 1, green: 1, blue: 1, alpha: 1)
        g.materials = [m]
        return g
    }
}

func mix(_ a: V3, _ b: V3, _ t: Float) -> V3 { a + (b - a) * min(max(t, 0), 1) }
func smooth(_ lo: Float, _ hi: Float, _ x: Float) -> Float { let t = min(max((x - lo) / (hi - lo), 0), 1); return t * t * (3 - 2 * t) }

func hash(_ x: Int, _ y: Int, _ seed: Int = 0) -> Float {
    var n = UInt32(truncatingIfNeeded: x &* 374761393 &+ y &* 668265263 &+ seed &* 2147483647)
    n = (n ^ (n >> 13)) &* 1274126177; n ^= n >> 16
    return Float(n & 0xFFFFFF) / Float(0xFFFFFF)
}
/// 平滑的随机起伏（0…1），用来让树林有疏有密
func noise(_ p: V2, scale: Float, seed: Int = 0) -> Float {
    let q = p / scale; let ix = Int(floor(q.x)), iy = Int(floor(q.y))
    let fx = q.x - Float(ix), fy = q.y - Float(iy)
    let ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy)
    let a = hash(ix, iy, seed), b = hash(ix + 1, iy, seed), c = hash(ix, iy + 1, seed), d = hash(ix + 1, iy + 1, seed)
    return a * (1 - ux) * (1 - uy) + b * ux * (1 - uy) + c * (1 - ux) * uy + d * ux * uy
}

/// 沿折线每隔 step 米取一个点
func resample(_ pts: [V2], step: Float) -> [V2] {
    guard let first = pts.first, let last = pts.last else { return [] }
    var out = [first]; var carry: Float = 0
    for (a, b) in zip(pts, pts.dropFirst()) {
        let len = simd_distance(a, b); if len < 0.01 { continue }
        var t = step - carry
        while t < len { out.append(a + (b - a) * (t / len)); t += step }
        carry = len - (t - step)
    }
    if simd_distance(out[out.count - 1], last) > 0.5 { out.append(last) }
    return out
}

/// 一张灰度位图，用来记“哪里是雪道走廊”（树不能种在雪道上）
struct Mask {
    let w: Int, h: Int; let data: [UInt8]; let width: Float, depth: Float
    init(terrain: Terrain, edges: [TrailEdge], widthFor: (TrailEdge) -> Float) {
        width = terrain.width; depth = terrain.depth
        w = terrain.cols * 2; h = terrain.rows * 2
        let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w,
                            space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue)!
        ctx.translateBy(x: 0, y: CGFloat(h)); ctx.scaleBy(x: 1, y: -1)   // 让 y 向下 = 内存里的行号
        ctx.setFillColor(gray: 0, alpha: 1); ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
        ctx.setStrokeColor(gray: 1, alpha: 1); ctx.setLineCap(.round); ctx.setLineJoin(.round)
        let sx = CGFloat(Float(w) / width), sy = CGFloat(Float(h) / depth)
        for e in edges {
            let lw = widthFor(e); if lw <= 0 { continue }
            ctx.setLineWidth(CGFloat(lw) * sx)
            ctx.beginPath()
            for (i, p) in e.pts.enumerated() {
                let q = CGPoint(x: CGFloat(p.x + width / 2) * sx, y: CGFloat(p.y + depth / 2) * sy)
                if i == 0 { ctx.move(to: q) } else { ctx.addLine(to: q) }
            }
            ctx.strokePath()
        }
        data = Array(UnsafeBufferPointer(start: ctx.data!.assumingMemoryBound(to: UInt8.self), count: w * h))
    }
    func value(_ p: V2) -> Float {
        let x = Int((p.x + width / 2) / width * Float(w)), y = Int((p.y + depth / 2) / depth * Float(h))
        guard x >= 0, y >= 0, x < w, y < h else { return 0 }
        return Float(data[y * w + x]) / 255
    }
}

// MARK: - 样式

struct TrailMapStyle {
    var exaggeration: Float = 1.5            // 高度夸张
    var runWidth: Float = 40, runOutline: Float = 58
    var liftScale: Float = 1                 // 缆车线、支柱、站房的粗细倍数（远看要画粗一点）
    var treeSpacing: Float = 40, treeHeight: Float = 54, treeRadius: Float = 16
    var sunSnow = V3(1.0, 0.995, 0.98), shadowSnow = V3(0.50, 0.63, 0.88)
    var haze = V3(0.84, 0.91, 0.97)

    /// 线的粗细跟着观看距离走：离得远就画粗，保证在画面上差不多一样宽。k = 1 大约对应 9 公里外
    func lines(scale k: Float) -> TrailMapStyle {
        var s = self; s.runWidth = 40 * k; s.runOutline = 58 * k; s.liftScale = k; return s
    }
    static func runColor(_ d: Int, closed: Bool = false) -> V3 {
        if closed { return V3(0.55, 0.57, 0.60) }
        switch d {
        case 1: return V3(0.13, 0.66, 0.33)
        case 2: return V3(0.90, 0.20, 0.22)
        case 3, 4: return V3(0.10, 0.10, 0.13)
        default: return V3(0.45, 0.50, 0.58)
        }
    }
    static let route = V3(0.0, 0.80, 0.95)
}

// MARK: - 场景

final class TrailMapScene {
    let scene = SCNScene()
    let terrain: Terrain
    let edges: [TrailEdge]
    let style: TrailMapStyle
    let uphill: V2           // 从山脚看向山顶的方向（水平）
    let light: V3            // 指向光源的方向
    let center: V2, radius: Float   // 雪道范围的中心和半径
    private(set) var treeCount = 0
    let runsNode = SCNNode(), liftsNode = SCNNode(), routeNode = SCNNode()

    /// 世界坐标：y = (真实高度 − 最低点) × 夸张倍数
    func world(_ p: V2, lift: Float = 0) -> V3 { V3(p.x, (terrain.height(p) - terrain.minH) * style.exaggeration + lift, p.y) }

    /// stride：地形网格隔几格取一个点（手机上用 2，省一半以上的生成时间，看不出差别）
    init(terrain: Terrain, edges: [TrailEdge], style: TrailMapStyle = .init(), stride: Int = 1, lineScale: Float = 1.3) {
        self.terrain = terrain; self.edges = edges; self.style = style
        // 观看方向：从低处（山脚）看向高处（山顶），和官方雪道图一样
        let all = edges.flatMap { $0.pts }
        if all.count >= 8 {
            let sorted = all.sorted { terrain.height($0) < terrain.height($1) }
            let q = max(1, sorted.count / 4)
            let low = sorted.prefix(q).reduce(V2(), +) / Float(q), high = sorted.suffix(q).reduce(V2(), +) / Float(q)
            uphill = simd_distance(low, high) > 1 ? simd_normalize(high - low) : V2(0, -1)
            let lo = all.reduce(V2(repeating: .infinity)) { simd_min($0, $1) }, hi = all.reduce(V2(repeating: -.infinity)) { simd_max($0, $1) }
            center = (lo + hi) / 2; radius = max(500, simd_distance(lo, hi) / 2)
        } else { uphill = V2(0, -1); center = V2(); radius = min(terrain.width, terrain.depth) / 2 }
        // 光从观察者的左前上方来：正对我们的山坡是亮的，右侧的沟谷有影子
        let f = V3(uphill.x, 0, uphill.y), right = simd_normalize(simd_cross(f, V3(0, 1, 0)))
        light = simd_normalize(-right * 0.75 + V3(0, 0.62, 0) - f * 0.30)

        let base = style.lines(scale: lineScale)
        let corridor = Mask(terrain: terrain, edges: edges) { e in
            switch e.kind { case .run: return base.runOutline + 16; case .lift: return 22 * base.liftScale; case .connector: return 16 }
        }
        scene.rootNode.addChildNode(SCNNode(geometry: buildTerrain(corridor, stride: max(1, stride))))
        let (trees, n) = buildTrees(corridor); treeCount = n
        scene.rootNode.addChildNode(SCNNode(geometry: trees))
        setLines(lineGeometry(scale: lineScale))
        scene.rootNode.addChildNode(runsNode); scene.rootNode.addChildNode(liftsNode); scene.rootNode.addChildNode(routeNode)

        // 地形外面垫一块雾色的大平面，边缘不会露出“世界尽头”
        let hazeColor = CGColor(red: CGFloat(style.haze.x), green: CGFloat(style.haze.y), blue: CGFloat(style.haze.z), alpha: 1)
        let ground = SCNPlane(width: 400_000, height: 400_000)
        let gm = SCNMaterial(); gm.lightingModel = .constant; gm.diffuse.contents = hazeColor
        ground.materials = [gm]
        let gn = SCNNode(geometry: ground); gn.eulerAngles.x = -.pi / 2; gn.position.y = -30
        scene.rootNode.addChildNode(gn)

        scene.background.contents = TrailMapScene.skyImage(top: V3(0.16, 0.45, 0.85), bottom: style.haze)
        scene.fogColor = hazeColor
    }

    static func skyImage(top: V3, bottom: V3) -> CGImage {
        let cs = CGColorSpace(name: CGColorSpace.sRGB)!
        let ctx = CGContext(data: nil, width: 8, height: 512, bitsPerComponent: 8, bytesPerRow: 0, space: cs,
                            bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
        let c = { (v: V3) in CGColor(colorSpace: cs, components: [CGFloat(v.x), CGFloat(v.y), CGFloat(v.z), 1])! }
        let g = CGGradient(colorsSpace: cs, colors: [c(bottom), c(bottom), c(top)] as CFArray, locations: [0, 0.45, 1])!
        ctx.drawLinearGradient(g, start: .zero, end: CGPoint(x: 0, y: 512), options: [])
        return ctx.makeImage()!
    }

    // MARK: 取景

    /// 算出一个镜头位置，把这些点都框进画面。返回（镜头位置，看向的点）
    /// azimuth：相对“从山脚看山顶”转多少度；pitch：俯角；bottomInset：画面下方留给卡片的比例
    func frame(points: [V3], azimuth: Float = 0, pitch: Float = 27, fovV: Float, aspect: Float, bottomInset: Float = 0.2) -> (pos: V3, target: V3) {
        let a = azimuth * .pi / 180
        let dir = V2(uphill.x * cos(a) - uphill.y * sin(a), uphill.x * sin(a) + uphill.y * cos(a))
        let pr = pitch * .pi / 180
        let f = simd_normalize(V3(dir.x * cos(pr), -sin(pr), dir.y * cos(pr))), r = simd_normalize(simd_cross(f, V3(0, 1, 0))), u = simd_cross(r, f)
        let tanV = tan(fovV / 2 * .pi / 180), tanH = tanV * aspect
        guard !points.isEmpty else { let t = world(center); return (t - f * radius * 3, t) }
        var target = points.reduce(V3(), +) / Float(points.count), dist = max(radius / max(tanH, 0.05), 1500)
        for _ in 0..<6 {
            let p0 = target - f * dist
            var lo = V2(repeating: .infinity), hi = V2(repeating: -.infinity)
            for p in points { let d = p - p0, z = max(simd_dot(d, f), 1); let q = V2(simd_dot(d, r), simd_dot(d, u)) / z; lo = simd_min(lo, q); hi = simd_max(hi, q) }
            let mid = (lo + hi) / 2
            target += (r * mid.x + u * (mid.y - bottomInset * tanV)) * dist
            dist *= max((hi.x - lo.x) / (2 * tanH * 0.82), (hi.y - lo.y) / (2 * tanV * (0.92 - bottomInset)), 0.02)
            dist = max(dist, 900)
        }
        return (target - f * dist, target)
    }

    /// 从镜头到这个点之间有没有被山挡住
    func visible(_ p: V3, from pos: V3) -> Bool {
        for i in 1..<48 {
            let s = pos + (p - pos) * (Float(i) / 48), q = V2(s.x, s.z)
            if terrain.inside(q), world(q).y > s.y + 25 { return false }
        }
        return true
    }

    // MARK: 地形和树

    private func forestDensity(_ p: V2, corridor: Mask) -> Float {
        if corridor.value(p) > 0.3 { return 0 }
        let h = terrain.height(p), slope = atan(simd_length(terrain.gradient(p))) * 180 / .pi
        if slope > 42 { return 0 }
        let alt = 1 - smooth(1450, 1900, h) * 0.85                       // 越高树越稀
        let clump = smooth(0.32, 0.62, noise(p, scale: 260) * 0.65 + noise(p, scale: 90, seed: 7) * 0.35)
        return alt * (0.08 + 0.92 * clump) * 0.5
    }

    private func buildTerrain(_ corridor: Mask, stride st: Int) -> SCNGeometry {
        let m = MeshBuilder()
        let nc = (terrain.cols - 1) / st + 1, nr = (terrain.rows - 1) / st + 1
        let dx = terrain.width / Float(terrain.cols - 1) * Float(st), dz = terrain.depth / Float(terrain.rows - 1) * Float(st)
        m.pos.reserveCapacity(nc * nr * 3); m.col.reserveCapacity(nc * nr * 4); m.idx.reserveCapacity(nc * nr * 6)
        for r in 0..<nr { for c in 0..<nc {
            let p = V2(-terrain.width / 2 + Float(c) * dx, -terrain.depth / 2 + Float(r) * dz)
            let g = terrain.gradient(p)
            let n = simd_normalize(V3(-g.x * style.exaggeration, 1, -g.y * style.exaggeration))
            let lit = smooth(0.18, 0.92, simd_dot(n, light)), slope = atan(simd_length(g)) * 180 / .pi
            let onRun = corridor.value(p)
            var col = mix(style.shadowSnow, style.sunSnow, lit)
            // 很陡的地方露出岩石
            col = mix(col, mix(V3(0.36, 0.37, 0.42), V3(0.62, 0.60, 0.58), lit), smooth(38, 50, slope) * 0.85)
            // 树林底下压暗一点、带点绿
            col = mix(col, mix(V3(0.20, 0.33, 0.36), V3(0.46, 0.60, 0.52), lit), forestDensity(p, corridor: corridor) * 0.9)
            // 雪道以外的地方整体压灰：不是雪道，按“不要进去”来画，雪道才显眼
            col = mix(col, V3(0.58, 0.64, 0.73) * (0.72 + 0.28 * lit), (1 - onRun) * 0.45)
            // 压过雪的雪道更白
            col = mix(col, mix(V3(0.86, 0.91, 1.0), V3(1, 1, 1), lit), onRun * 0.95)
            // 靠近边缘渐渐融进雾里
            let edge = min(terrain.width / 2 - abs(p.x), terrain.depth / 2 - abs(p.y))
            col = mix(style.haze, col, smooth(0, 900, edge))
            m.add(V3(p.x, (terrain.h[min(r * st, terrain.rows - 1) * terrain.cols + min(c * st, terrain.cols - 1)] - terrain.minH) * style.exaggeration, p.y), col)
        } }
        for r in 0..<(nr - 1) { for c in 0..<(nc - 1) {
            let i = UInt32(r * nc + c), j = i + UInt32(nc)
            m.tri(i, j, i + 1); m.tri(i + 1, j, j + 1)
        } }
        return m.geometry()
    }

    private func buildTrees(_ corridor: Mask) -> (SCNGeometry, Int) {
        let m = MeshBuilder(); var n = 0
        let s = style.treeSpacing, sides = 6
        let nx = Int(terrain.width / s), nz = Int(terrain.depth / s)
        // 每个方向的明暗只算一次
        let ringDirs: [(V2, Float)] = (0..<sides).map { k in
            let a = Float(k) / Float(sides) * 2 * .pi
            return (V2(cos(a), sin(a)), smooth(-0.2, 0.9, simd_dot(simd_normalize(V3(cos(a), 0.35, sin(a))), light)))
        }
        for iz in 0..<nz { for ix in 0..<nx {
            let p = V2(-terrain.width / 2 + (Float(ix) + hash(ix, iz, 1)) * s, -terrain.depth / 2 + (Float(iz) + hash(ix, iz, 2)) * s)
            let edge = min(terrain.width / 2 - abs(p.x), terrain.depth / 2 - abs(p.y))
            if edge < 250 { continue }
            let roll = hash(ix, iz, 3); if roll > 0.5 { continue }       // 密度最多 0.5，先便宜地筛掉一半
            if roll > forestDensity(p, corridor: corridor) * smooth(200, 900, edge) { continue }
            let k = 0.7 + 0.6 * hash(ix, iz, 4)
            let hgt = style.treeHeight * k, rad = style.treeRadius * (0.85 + 0.3 * hash(ix, iz, 5))
            let base = world(p, lift: -2), tip = base + V3(0, hgt, 0)
            let tone = 0.8 + 0.4 * hash(ix, iz, 6)
            let fade = smooth(200, 1100, edge)
            let tipI = m.add(tip, mix(style.haze, V3(0.62, 0.78, 0.74) * tone, fade))          // 树尖亮一点，像挂着雪
            let first = m.count
            for (d, lit) in ringDirs {
                let col = mix(V3(0.04, 0.15, 0.14), V3(0.16, 0.38, 0.24), lit) * tone
                m.add(base + V3(d.x * rad, 0, d.y * rad), mix(style.haze, mix(col, V3(0.42, 0.50, 0.55), 0.4), fade))
            }
            for k in 0..<UInt32(sides) { m.tri(tipI, first + k, first + (k + 1) % UInt32(sides)) }
            n += 1
        } }
        return (m.geometry(), n)
    }

    // MARK: 雪道、缆车、路线（可以按观看距离重建）

    /// 贴着山坡的带子
    private func ribbon(_ m: MeshBuilder, _ pts: [V2], width: Float, lift: Float, color: V3, dash: (on: Float, off: Float)? = nil) {
        let step: Float = max(8, width * 0.3), across = 4
        let c = resample(pts, step: step); guard c.count >= 2 else { return }
        var prevRow: UInt32? = nil; var dist: Float = 0
        for i in 0..<c.count {
            if i > 0 { dist += simd_distance(c[i], c[i - 1]) }
            if let d = dash, dist.truncatingRemainder(dividingBy: d.on + d.off) > d.on { prevRow = nil; continue }
            let tv = c[min(i + 1, c.count - 1)] - c[max(i - 1, 0)]
            let t = simd_length(tv) > 0.001 ? simd_normalize(tv) : V2(1, 0), nrm = V2(-t.y, t.x)
            let row = m.count
            for k in 0..<across {
                let off = (Float(k) / Float(across - 1) - 0.5) * width
                m.add(world(c[i] + nrm * off, lift: lift), color)
            }
            if let p = prevRow { for k in 0..<UInt32(across - 1) {
                m.tri(p + k, row + k, p + k + 1); m.tri(p + k + 1, row + k, row + k + 1)
            } }
            prevRow = row
        }
    }

    private func prism(_ m: MeshBuilder, _ a: V3, _ b: V3, radius r: Float, color: V3) {
        guard simd_distance(a, b) > 0.01 else { return }
        let d = simd_normalize(b - a)
        var side = simd_cross(d, V3(0, 1, 0)); if simd_length(side) < 0.01 { side = V3(1, 0, 0) }
        side = simd_normalize(side); let up = simd_normalize(simd_cross(side, d))
        let o = [side * r + up * r, -side * r + up * r, -side * r - up * r, side * r - up * r]
        for k in 0..<4 {
            let n = simd_normalize(o[k] + o[(k + 1) % 4])
            let c = color * (0.75 + 0.5 * max(0, simd_dot(n, light)))
            m.quad(a + o[k], a + o[(k + 1) % 4], b + o[(k + 1) % 4], b + o[k], c)
        }
    }

    private func box(_ m: MeshBuilder, center p: V2, size: V3, wall: V3, roof: V3) {
        let y0 = world(p).y - 3, y1 = y0 + size.y, hx = size.x / 2, hz = size.z / 2
        let c = [V2(-hx, -hz), V2(hx, -hz), V2(hx, hz), V2(-hx, hz)].map { V3(p.x + $0.x, 0, p.y + $0.y) }
        for k in 0..<4 {
            let a = c[k], b = c[(k + 1) % 4]
            let n = simd_normalize(simd_cross(b - a, V3(0, 1, 0)))
            m.quad(a + V3(0, y0, 0), b + V3(0, y0, 0), b + V3(0, y1, 0), a + V3(0, y1, 0), wall * (0.7 + 0.4 * max(0, simd_dot(n, light))))
        }
        m.quad(c[0] + V3(0, y1, 0), c[1] + V3(0, y1, 0), c[2] + V3(0, y1, 0), c[3] + V3(0, y1, 0), roof)
    }

    /// 按粗细倍数生成雪道和缆车的几何体（可以在后台线程调用）
    func lineGeometry(scale k: Float) -> (runs: SCNGeometry, lifts: SCNGeometry) {
        let s = style.lines(scale: k)
        let m = MeshBuilder()
        // 三层：最外面深色描边、白边、难度颜色，靠抬高的高度分层
        for e in edges where e.kind == .run { ribbon(m, e.pts, width: s.runOutline + s.runWidth * 0.3, lift: 3, color: V3(0.16, 0.22, 0.34)) }
        for e in edges where e.kind == .run { ribbon(m, e.pts, width: s.runOutline, lift: 5, color: V3(1, 1, 1)) }
        for e in edges where e.kind == .run { ribbon(m, e.pts, width: s.runWidth, lift: 8, color: TrailMapStyle.runColor(e.difficulty, closed: e.closed)) }
        // 步行连接画虚线；程序推算出来的（未核实）用橙色
        for e in edges where e.kind == .connector {
            ribbon(m, e.pts, width: s.runWidth * 0.55, lift: 8, color: e.uncertain ? V3(1.0, 0.58, 0.10) : V3(0.10, 0.62, 0.62), dash: (s.runWidth * 0.8, s.runWidth * 0.7))
        }
        let l = MeshBuilder()
        for e in edges where e.kind == .lift {
            let cable = e.bigLift ? V3(0.72, 0.10, 0.12) : V3(0.13, 0.15, 0.22)
            let len = e.length; guard len > 20 else { continue }
            let n = max(1, Int((len / 140).rounded()))
            let c = resample(e.pts, step: len / Float(n) - 0.01); guard c.count >= 2 else { continue }
            let tops = c.enumerated().map { i, p in world(p, lift: ((i == 0 || i == c.count - 1) ? 14 : 30) * s.liftScale) }
            for (a, b) in zip(tops, tops.dropFirst()) { prism(l, a, b, radius: (e.bigLift ? 5 : 3.5) * s.liftScale, color: cable) }
            for (i, p) in c.enumerated() where i > 0 && i < c.count - 1 {
                prism(l, world(p, lift: -3), tops[i], radius: 2.6 * s.liftScale, color: V3(0.30, 0.32, 0.38))
            }
            for p in [c[0], c[c.count - 1]] {
                box(l, center: p, size: (e.bigLift ? V3(64, 30, 64) : V3(44, 22, 44)) * s.liftScale, wall: V3(0.93, 0.90, 0.84),
                    roof: e.bigLift ? V3(0.72, 0.10, 0.12) : V3(0.20, 0.32, 0.55))
            }
        }
        return (m.geometry(), l.geometry())
    }

    func setLines(_ g: (runs: SCNGeometry, lifts: SCNGeometry)) { runsNode.geometry = g.runs; liftsNode.geometry = g.lifts }

    /// 当前路线：青色粗线压在雪道上面（预览 = 虚线）
    func routeGeometry(edgeIds: [String], preview: Bool, scale k: Float) -> SCNGeometry? {
        let set = Set(edgeIds); guard !set.isEmpty else { return nil }
        let s = style.lines(scale: k), m = MeshBuilder()
        for e in edges where set.contains(e.id) {
            let lift: Float = e.kind == .lift ? 34 * s.liftScale : 12
            ribbon(m, e.pts, width: s.runOutline * 0.95, lift: lift, color: V3(1, 1, 1), dash: preview ? (s.runWidth * 1.6, s.runWidth * 1.1) : nil)
            ribbon(m, e.pts, width: s.runWidth * 0.95, lift: lift + 3, color: TrailMapStyle.route, dash: preview ? (s.runWidth * 1.6, s.runWidth * 1.1) : nil)
        }
        return m.idx.isEmpty ? nil : m.geometry()
    }
}
