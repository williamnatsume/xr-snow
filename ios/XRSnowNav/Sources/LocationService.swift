// 定位：CoreLocation，按导航场景配置，锁屏 / 放进口袋后继续更新（Background Modes: Location updates）。
// 位置只在内存中使用，不上传、不保存。

import CoreLocation

final class LocationService: NSObject, CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    private var backgroundSession: CLBackgroundActivitySession?
    var onLocation: ((CLLocation) -> Void)?
    var onStatus: ((String) -> Void)?
    private(set) var running = false

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBest
        manager.distanceFilter = kCLDistanceFilterNone
        manager.activityType = .otherNavigation
        manager.pausesLocationUpdatesAutomatically = false
    }

    var authorization: CLAuthorizationStatus { manager.authorizationStatus }

    func start() {
        running = true
        switch manager.authorizationStatus {
        case .notDetermined:
            manager.requestWhenInUseAuthorization()   // 授权后在回调里开始
        case .denied, .restricted:
            onStatus?("定位权限被拒绝：请在 设置 → 隐私与安全性 → 定位服务 → XR Snow 中允许")
        default:
            begin()
        }
    }

    private func begin() {
        manager.allowsBackgroundLocationUpdates = true
        manager.showsBackgroundLocationIndicator = true
        // iOS 17+：表明正在进行一项持续的后台定位活动（状态栏显示定位指示）
        if backgroundSession == nil { backgroundSession = CLBackgroundActivitySession() }
        manager.startUpdatingLocation()
        onStatus?("定位已开启")
    }

    func stop() {
        running = false
        manager.stopUpdatingLocation()
        manager.allowsBackgroundLocationUpdates = false
        backgroundSession?.invalidate()
        backgroundSession = nil
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        guard running else { return }
        switch manager.authorizationStatus {
        case .authorizedWhenInUse, .authorizedAlways: begin()
        case .denied, .restricted: onStatus?("定位权限被拒绝：请在 设置 → 隐私与安全性 → 定位服务 → XR Snow 中允许")
        default: break
        }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        for loc in locations { onLocation?(loc) }
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        if (error as? CLError)?.code == .locationUnknown { return } // 暂时拿不到位置，会自动重试
        onStatus?("定位出错：\(error.localizedDescription)")
    }
}
