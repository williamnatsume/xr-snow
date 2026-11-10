// 轨迹记录：把每个定位点（含定位误差、设备速度）存下来，结束后导出 GPX（格式与网页版 speed-hud 相同）。
// 同时统计锁屏测试关心的数字：点数、最长中断、耗电。文件只存在本机 Documents/tracks，导出需用户操作。

import Foundation
import CoreLocation
import UIKit

struct TrackStats {
    var points = 0
    var startedAt: Date?
    var lastFixAt: Date?
    var maxGapSec: Double = 0
    var gapsOver10s = 0
    var batteryStart: Float?
    var batteryNow: Float?

    var durationSec: Double { guard let s = startedAt else { return 0 } ; return Date().timeIntervalSince(s) }
}

final class TrackRecorder {
    private(set) var recording = false
    private(set) var stats = TrackStats()
    private var points: [CLLocation] = []
    private(set) var lastFile: URL?

    func start() {
        points = []
        stats = TrackStats()
        stats.startedAt = Date()
        UIDevice.current.isBatteryMonitoringEnabled = true
        stats.batteryStart = batteryLevel()
        recording = true
    }

    func add(_ loc: CLLocation) {
        guard recording else { return }
        if let last = stats.lastFixAt {
            let gap = loc.timestamp.timeIntervalSince(last)
            stats.maxGapSec = max(stats.maxGapSec, gap)
            if gap > 10 { stats.gapsOver10s += 1 }
        }
        points.append(loc)
        stats.points = points.count
        stats.lastFixAt = loc.timestamp
        stats.batteryNow = batteryLevel()
    }

    // 距最后一个定位点多少秒（还没有定位时从开始算）
    func secondsSinceLastFix(now: Date = Date()) -> Double? {
        guard recording else { return nil }
        guard let t = stats.lastFixAt ?? stats.startedAt else { return nil }
        return now.timeIntervalSince(t)
    }

    @discardableResult
    func stop() -> URL? {
        guard recording else { return lastFile }
        recording = false
        stats.batteryNow = batteryLevel()
        guard !points.isEmpty else { return nil }
        lastFile = try? writeGPX()
        return lastFile
    }

    private func batteryLevel() -> Float? {
        let l = UIDevice.current.batteryLevel
        return l < 0 ? nil : l
    }

    private func writeGPX() throws -> URL {
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let body = points.map { p -> String in
            var s = "      <trkpt lat=\"\(p.coordinate.latitude)\" lon=\"\(p.coordinate.longitude)\">"
            if p.verticalAccuracy >= 0 { s += "<ele>\(String(format: "%.1f", p.altitude))</ele>" }
            s += "<time>\(iso.string(from: p.timestamp))</time><extensions>"
            if p.speed >= 0 { s += "<gpxtpx:TrackPointExtension><gpxtpx:speed>\(String(format: "%.2f", p.speed))</gpxtpx:speed></gpxtpx:TrackPointExtension>" }
            s += "<xrsnow:acc>\(String(format: "%.1f", p.horizontalAccuracy))</xrsnow:acc></extensions></trkpt>"
            return s
        }.joined(separator: "\n")
        let start = stats.startedAt ?? points[0].timestamp
        let name = DateFormatter.localizedString(from: start, dateStyle: .short, timeStyle: .short)
        let xml = """
        <?xml version="1.0" encoding="UTF-8"?>
        <gpx version="1.1" creator="雪人 iOS"
          xmlns="http://www.topografix.com/GPX/1/1"
          xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v2"
          xmlns:xrsnow="https://williamnatsume.github.io/xr-snow/gpx/v1">
          <metadata><time>\(iso.string(from: start))</time></metadata>
          <trk>
            <name>雪人 \(name)</name>
            <trkseg>
        \(body)
            </trkseg>
          </trk>
        </gpx>

        """
        let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("tracks", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let f = DateFormatter()
        f.dateFormat = "yyyyMMdd-HHmm"
        let url = dir.appendingPathComponent("xueren-\(f.string(from: start)).gpx")
        try xml.write(to: url, atomically: true, encoding: .utf8)
        return url
    }
}
