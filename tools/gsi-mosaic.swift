// 下载国土地理院 シームレス空中写真 瓦片并拼成 1024px 的大图（每张 4×4 瓦片），输出索引 JSON。
// 用法：swift gsi-mosaic.swift <south> <west> <north> <east> <zoom> <输出目录> <名字>
import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

let a = CommandLine.arguments
let (s, w, n, e) = (Double(a[1])!, Double(a[2])!, Double(a[3])!, Double(a[4])!)
let z = Int(a[5])!, outDir = a[6], name = a[7]
let N = Double(1 << z)
func tx(_ lon: Double) -> Int { Int(floor((lon + 180) / 360 * N)) }
func ty(_ lat: Double) -> Int { let r = lat * .pi / 180; return Int(floor((1 - log(tan(r) + 1 / cos(r)) / .pi) / 2 * N)) }
func lonOf(_ x: Int) -> Double { Double(x) / N * 360 - 180 }
func latOf(_ y: Int) -> Double { let k = Double.pi * (1 - 2 * Double(y) / N); return atan(sinh(k)) * 180 / .pi }
let x0 = tx(w), x1 = tx(e), y0 = ty(n), y1 = ty(s)
print("瓦片 x \(x0)...\(x1) y \(y0)...\(y1)，共 \((x1 - x0 + 1) * (y1 - y0 + 1)) 张")
try? FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)

// 下载（并发 6）
var tiles = [String: CGImage]()
let lock = NSLock()
let sem = DispatchSemaphore(value: 6)
let group = DispatchGroup()
var failed = 0
for x in x0...x1 { for y in y0...y1 {
    sem.wait(); group.enter()
    let url = URL(string: "https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/\(z)/\(x)/\(y).jpg")!
    var req = URLRequest(url: url); req.setValue("XRSnow-Xueren/0.1 (ski map review prototype)", forHTTPHeaderField: "User-Agent")
    URLSession.shared.dataTask(with: req) { d, r, _ in
        defer { sem.signal(); group.leave() }
        guard let d, (r as? HTTPURLResponse)?.statusCode == 200, let src = CGImageSourceCreateWithData(d as CFData, nil),
              let img = CGImageSourceCreateImageAtIndex(src, 0, nil) else { lock.lock(); failed += 1; lock.unlock(); return }
        lock.lock(); tiles["\(x),\(y)"] = img; lock.unlock()
    }.resume()
}}
group.wait()
print("下载完成，失败 \(failed)")

// 拼图：每 4×4 瓦片一张
var index: [[String: Any]] = []
var cx = x0
while cx <= x1 {
    var cy = y0
    while cy <= y1 {
        let ex = min(cx + 3, x1), ey = min(cy + 3, y1)
        let W = (ex - cx + 1) * 256, H = (ey - cy + 1) * 256
        let ctx = CGContext(data: nil, width: W, height: H, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
        ctx.setFillColor(CGColor(red: 0.85, green: 0.86, blue: 0.84, alpha: 1)); ctx.fill(CGRect(x: 0, y: 0, width: W, height: H))
        var any = false
        for x in cx...ex { for y in cy...ey {
            if let img = tiles["\(x),\(y)"] {
                any = true
                ctx.draw(img, in: CGRect(x: (x - cx) * 256, y: H - (y - cy + 1) * 256, width: 256, height: 256))
            }
        }}
        if any, let out = ctx.makeImage() {
            let file = "\(name)-\(cx)-\(cy).jpg"
            let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: "\(outDir)/\(file)") as CFURL, UTType.jpeg.identifier as CFString, 1, nil)!
            CGImageDestinationAddImage(dest, out, [kCGImageDestinationLossyCompressionQuality: 0.62] as CFDictionary)
            CGImageDestinationFinalize(dest)
            index.append(["file": file, "bounds": [[latOf(ey + 1), lonOf(cx)], [latOf(cy), lonOf(ex + 1)]]])
        }
        cy += 4
    }
    cx += 4
}
let data = try JSONSerialization.data(withJSONObject: index)
try data.write(to: URL(fileURLWithPath: "\(outDir)/\(name)-images.json"))
print("拼成 \(index.count) 张")
