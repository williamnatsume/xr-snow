// 自动下载雪场地图（OpenStreetMap，ODbL）：
//   1. 用位置在 Overpass 里找附近的雪场区域（landuse=winter_sports）
//   2. 下载范围内的雪道 / 缆车 / 餐厅
//   3. 查高程：日本用国土地理院 標高API（精度高），其他地区用 Open-Meteo（Copernicus DEM）
//   4. 交给 JS（nav/osm-import.js，和 Mac 上的 tools/import-osm.mjs 同一份）转换，存到 Documents/resorts，离线可用
// 只下载开放数据；不抓取任何商业 App 的地图。

import Foundation
import CoreLocation

struct SkiArea: Decodable, Identifiable, Hashable {
    struct BBox: Codable, Hashable { let minLat, minLon, maxLat, maxLon: Double }
    let osm: String
    let name: String
    let name_ja: String?
    let bbox: BBox
    let inside: Bool
    let dist_m: Double
    var id: String { osm }
}

struct MapQuality: Decodable {
    let runs: Int
    let lifts: Int
    let namedRuns: Int
    let unknownDifficulty: Int
    let derivedConnections: Int
    let unlinkedLiftEnds: Int
    let directionConflicts: Int
    let elevationKnown: Double
    let traceConfirmed: Int?
    var summary: String {
        let named = runs > 0 ? Int(Double(namedRuns) / Double(runs) * 100) : 0
        let confirmed = traceConfirmed.map { "（其中 \($0) 处有公开轨迹佐证）" } ?? ""
        return "雪道 \(runs) 段（有名字 \(named)%），缆车 \(lifts) 条；推算连接 \(derivedConnections) 处\(confirmed)，未连上的缆车站 \(unlinkedLiftEnds) 个"
    }
}

// 打包在 App 里的雪场 + 下载的雪场
enum ResortStore {
    static let bundled: [(String, String)] = [("demo-fictional", "虚构演示雪场"), ("kagura-osm", "神乐（OSM，内置）")]

    static var dir: URL {
        let d = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("resorts", isDirectory: true)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }

    static func downloadedURL(_ id: String) -> URL { dir.appendingPathComponent("\(id).json") }

    static func downloaded() -> [(String, String)] {
        let files = (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? []
        return files.filter { $0.pathExtension == "json" }.compactMap { url in
            guard let d = try? Data(contentsOf: url), let obj = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
                  let name = obj["name"] as? String else { return nil }
            return (url.deletingPathExtension().lastPathComponent, name)
        }.sorted { $0.1 < $1.1 }
    }

    static func all() -> [(String, String)] { bundled + downloaded() }

    static func quality(_ id: String) -> MapQuality? {
        guard let text = try? NavCore.resortText(id), let d = text.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
              let report = obj["importReport"] as? [String: Any], let q = report["quality"],
              let qd = try? JSONSerialization.data(withJSONObject: q) else { return nil }
        return try? JSONDecoder().decode(MapQuality.self, from: qd)
    }

    // 已下载的雪场里，范围包含这个位置的
    static func covering(lat: Double, lon: Double) -> String? {
        for (id, _) in downloaded() {
            guard let d = try? Data(contentsOf: downloadedURL(id)), let obj = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
                  let prov = obj["provenance"] as? [String: Any], let b = prov["bbox"] as? [String: Double] else { continue }
            if let a = b["minLat"], let c = b["maxLat"], let e = b["minLon"], let f = b["maxLon"], lat >= a, lat <= c, lon >= e, lon <= f { return id }
        }
        return nil
    }
}

enum MapError: LocalizedError {
    case network(String), noArea, convert(String)
    var errorDescription: String? {
        switch self {
        case .network(let m): return "网络请求失败：\(m)"
        case .noArea: return "附近没有找到雪场（OpenStreetMap 上没有标出雪场范围）"
        case .convert(let m): return "地图转换失败：\(m)"
        }
    }
}

@MainActor
final class MapDownloader {
    private let core: NavCore
    var onProgress: ((String) -> Void)?
    private let http: URLSession = {
        let c = URLSessionConfiguration.default
        c.timeoutIntervalForRequest = 120
        c.httpAdditionalHeaders = ["User-Agent": "XRSnow-Xueren/0.1 (personal ski navigation prototype)"]
        return URLSession(configuration: c)
    }()
    private let overpassServers = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"]

    init(core: NavCore) { self.core = core }

    func nearby(lat: Double, lon: Double, radiusKm: Double = 8) async throws -> [SkiArea] {
        guard let q = core.osm("skiAreaQuery", [lat, lon, radiusKm]) else { throw MapError.convert("查询生成失败") }
        let raw = try await overpass(q)
        guard let json = core.osm("parseSkiAreas", [raw, lat, lon]), let d = json.data(using: .utf8) else { throw MapError.convert("解析失败") }
        return try JSONDecoder().decode([SkiArea].self, from: d)
    }

    // 下载并转换，返回雪场 id
    func download(_ area: SkiArea) async throws -> (String, MapQuality?) {
        let bboxJSON = String(data: try JSONEncoder().encode(area.bbox), encoding: .utf8)!
        guard let q = core.osm("downloadQuery", [bboxJSON]) else { throw MapError.convert("查询生成失败") }
        onProgress?("正在下载 \(area.name) 的雪道和缆车…")
        let raw = try await overpass(q)
        XLog("[地图] %@ 下载 %d KB", area.name, raw.utf8.count / 1024)

        let id = "osm-" + area.osm.replacingOccurrences(of: "/", with: "-")
        // 范围：雪场区域外扩 500 m（和下载用的范围一致）
        let pad = 500.0 / 111_320, padLon = 500.0 / (111_320 * cos((area.bbox.minLat + area.bbox.maxLat) / 2 * .pi / 180))
        let box: [String: Double] = ["minLat": area.bbox.minLat - pad, "maxLat": area.bbox.maxLat + pad,
                                     "minLon": area.bbox.minLon - padLon, "maxLon": area.bbox.maxLon + padLon]
        let japan = (24.0...46.0).contains(area.bbox.minLat) && (122.0...154.0).contains(area.bbox.minLon)
        let opts: [String: Any] = [
            "id": id, "name": "\(area.name)（OSM）", "region": "", "bbox": box,
            "elevationSource": japan ? "国土地理院 標高API（出典：国土地理院）" : "Open-Meteo Elevation API（Copernicus DEM GLO-90）",
            "importer": "iOS 自动下载（nav/osm-import.js）"
        ]
        let optsJSON = String(data: try JSONSerialization.data(withJSONObject: opts), encoding: .utf8)!
        guard let ptsJSON = core.osm("elevationPoints", [raw, optsJSON]), let pd = ptsJSON.data(using: .utf8),
              let pts = try JSONSerialization.jsonObject(with: pd) as? [[Double]] else { throw MapError.convert("没有可用的雪道") }
        onProgress?("正在查询 \(pts.count) 个点的海拔…")
        let elev = japan ? await gsiElevations(pts) : await openMeteoElevations(pts)
        let elevJSON = String(data: try JSONSerialization.data(withJSONObject: elev), encoding: .utf8)!
        guard let resJSON = core.osm("convert", [raw, optsJSON, elevJSON]), let rd = resJSON.data(using: .utf8),
              let res = try JSONSerialization.jsonObject(with: rd) as? [String: Any] else { throw MapError.convert("转换出错") }
        guard res["ok"] as? Bool == true, var resort = res["resort"] as? String else {
            throw MapError.convert((res["errors"] as? [String])?.joined(separator: "；") ?? "这一带没有可用的雪道数据")
        }
        // 用 OpenStreetMap 上公开的 GPS 轨迹核对：有人走过的推算连接不再算“不确定”（失败不影响使用）
        if let checked = await verifyWithTraces(resort: resort, box: box) { resort = checked }
        try resort.write(to: ResortStore.downloadedURL(id), atomically: true, encoding: .utf8)
        var quality: MapQuality?
        if let q = res["quality"], let qd = try? JSONSerialization.data(withJSONObject: q) { quality = try? JSONDecoder().decode(MapQuality.self, from: qd) }
        XLog("[地图] 已保存 %@：%@", id, quality?.summary ?? "")
        return (id, quality)
    }

    private func verifyWithTraces(resort: String, box: [String: Double]) async -> String? {
        guard let bj = try? JSONSerialization.data(withJSONObject: box), let tilesJSON = core.osm("traceTiles", [String(data: bj, encoding: .utf8)!]),
              let tiles = try? JSONSerialization.jsonObject(with: Data(tilesJSON.utf8)) as? [String] else { return nil }
        onProgress?("正在用公开轨迹核对地图…")
        var gpx: [String] = []
        var requests = 0
        for tile in tiles {
            for page in 0..<5 {
                guard requests < 40 else { break }   // 对 OSM 服务器客气一点
                requests += 1
                guard let url = URL(string: "https://api.openstreetmap.org/api/0.6/trackpoints?bbox=\(tile)&page=\(page)"),
                      let (d, resp) = try? await http.data(from: url), (resp as? HTTPURLResponse)?.statusCode == 200,
                      let text = String(data: d, encoding: .utf8) else { break }
                gpx.append(text)
                let n = text.components(separatedBy: "<trkpt").count - 1
                try? await Task.sleep(for: .milliseconds(300))
                if n < 5000 { break }
            }
        }
        guard let listData = try? JSONSerialization.data(withJSONObject: gpx), let out = core.osm("applyTraces", [resort, String(data: listData, encoding: .utf8)!]),
              let obj = try? JSONSerialization.jsonObject(with: Data(out.utf8)) as? [String: Any] else { return nil }
        let summary = obj["summary"] as? [String: Any] ?? [:]
        XLog("[地图] 公开轨迹核对：%@", String(describing: summary))
        guard obj["ok"] as? Bool == true else { return nil }
        return obj["resort"] as? String
    }

    private func overpass(_ query: String) async throws -> String {
        var lastError = "未知错误"
        for server in overpassServers {
            var req = URLRequest(url: URL(string: server)!)
            req.httpMethod = "POST"
            req.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
            let body = "data=" + (query.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "")
            req.httpBody = body.data(using: .utf8)
            do {
                let (data, resp) = try await http.data(for: req)
                let code = (resp as? HTTPURLResponse)?.statusCode ?? -1
                if code == 200, let s = String(data: data, encoding: .utf8) { return s }
                lastError = "HTTP \(code)"
            } catch {
                lastError = error.localizedDescription
            }
            XLog("[地图] Overpass %@ 失败：%@，换下一个服务器", server, lastError)
        }
        throw MapError.network(lastError)
    }

    // 国土地理院：一次一个点，并发 6 个
    private func gsiElevations(_ pts: [[Double]]) async -> [[Double?]] {
        var out = [[Double?]](repeating: [], count: pts.count)
        await withTaskGroup(of: (Int, Double?).self) { group in
            var next = 0
            func add() {
                guard next < pts.count else { return }
                let i = next; next += 1
                let p = pts[i]
                group.addTask { [http] in
                    let url = URL(string: String(format: "https://cyberjapandata2.gsi.go.jp/general/dem/scripts/getelevation.php?lon=%.6f&lat=%.6f&outtype=JSON", p[1], p[0]))!
                    for _ in 0..<3 {
                        if let (d, _) = try? await http.data(from: url),
                           let obj = try? JSONSerialization.jsonObject(with: d) as? [String: Any] {
                            return (i, obj["elevation"] as? Double)
                        }
                        try? await Task.sleep(for: .milliseconds(500))
                    }
                    return (i, nil)
                }
            }
            for _ in 0..<6 { add() }
            var done = 0
            for await (i, e) in group {
                out[i] = [pts[i][0], pts[i][1], e]
                done += 1
                if done % 20 == 0 { onProgress?("海拔 \(done)/\(pts.count)…") }
                add()
            }
        }
        return out
    }

    // Open-Meteo：一次最多 100 个点
    private func openMeteoElevations(_ pts: [[Double]]) async -> [[Double?]] {
        var out: [[Double?]] = []
        for start in stride(from: 0, to: pts.count, by: 100) {
            let chunk = Array(pts[start..<min(start + 100, pts.count)])
            let lats = chunk.map { String(format: "%.6f", $0[0]) }.joined(separator: ",")
            let lons = chunk.map { String(format: "%.6f", $0[1]) }.joined(separator: ",")
            var values: [Double?] = Array(repeating: nil, count: chunk.count)
            if let url = URL(string: "https://api.open-meteo.com/v1/elevation?latitude=\(lats)&longitude=\(lons)"),
               let (d, _) = try? await http.data(from: url),
               let obj = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
               let arr = obj["elevation"] as? [Double] {
                values = arr.map { Optional($0) }
            }
            for (i, p) in chunk.enumerated() { out.append([p[0], p[1], i < values.count ? values[i] : nil]) }
        }
        return out
    }
}

// 只要一次当前位置（下载“附近的雪场”用）
@MainActor
final class OneShotLocation: NSObject, CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    private var cont: CheckedContinuation<CLLocation?, Never>?

    func get() async -> CLLocation? {
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
        if manager.authorizationStatus == .notDetermined { manager.requestWhenInUseAuthorization() }
        return await withCheckedContinuation { c in
            cont = c
            manager.requestLocation()
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        Task { @MainActor in self.cont?.resume(returning: locations.last); self.cont = nil }
    }
    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        Task { @MainActor in self.cont?.resume(returning: nil); self.cont = nil }
    }
    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        Task { @MainActor in
            if manager.authorizationStatus == .authorizedWhenInUse || manager.authorizationStatus == .authorizedAlways, self.cont != nil {
                manager.requestLocation()
            }
        }
    }
}
