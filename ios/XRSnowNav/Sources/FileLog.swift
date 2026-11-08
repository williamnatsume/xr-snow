// 运行日志写进 App 的 Documents/logs（每天一个文件，保留 7 天），方便事后复盘对话。
// 开发机取回：xcrun devicectl device copy from --device <UDID> --domain-type appDataContainer
//   --domain-identifier io.github.williamnatsume.XRSnowNav --source Documents/logs --destination <本地目录>
// 只在本机，不上传。

import Foundation

func XLog(_ format: String, _ args: CVarArg...) {
    let msg = String(format: format, arguments: args)
    NSLog("%@", msg)
    FileLog.shared.write(msg)
}

final class FileLog: @unchecked Sendable {
    static let shared = FileLog()
    private let queue = DispatchQueue(label: "xueren.filelog")
    private let dir: URL
    private let stamp: DateFormatter = { let f = DateFormatter(); f.dateFormat = "HH:mm:ss.SSS"; return f }()
    private let day: DateFormatter = { let f = DateFormatter(); f.dateFormat = "yyyyMMdd"; return f }()

    private init() {
        dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("logs", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        cleanup()
    }

    func write(_ msg: String) {
        let now = Date()
        queue.async { [self] in
            let url = dir.appendingPathComponent("xueren-\(day.string(from: now)).log")
            let line = "\(stamp.string(from: now)) \(msg)\n"
            if let h = try? FileHandle(forWritingTo: url) {
                h.seekToEndOfFile(); h.write(Data(line.utf8)); try? h.close()
            } else {
                try? line.write(to: url, atomically: true, encoding: .utf8)
            }
        }
    }

    private func cleanup() {
        let files = (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.creationDateKey])) ?? []
        let cutoff = Date().addingTimeInterval(-7 * 86400)
        for f in files {
            if let d = try? f.resourceValues(forKeys: [.creationDateKey]).creationDate, d < cutoff { try? FileManager.default.removeItem(at: f) }
        }
    }
}
