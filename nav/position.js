// 定位适配层：真实 GPS（浏览器 Geolocation）。
// 与速度 HUD（speed-hud.html）使用相同的取舍：
//   - enableHighAccuracy + maximumAge 0
//   - 优先使用设备给出的速度（iPhone 是多普勒测速，比位置差准）
//   - 误差 > 50 m 时不采用设备速度
// 导航只接收统一格式的定位点：{ t, x, y, acc, speed, source }
//
// 注意：网页只能在前台、屏幕亮着时定位。iPhone 锁屏或切到后台后定位会停止，
// 导航状态机会因此进入“定位中断”，不会继续把旧位置当成实时位置。
// 以后换成原生 iOS（CLLocationManager 后台定位）时实现同样的 start/stop 接口即可。

export class GpsSource {
  constructor(resort, { onFix, onStatus }) {
    this.resort = resort;
    this.onFix = onFix;
    this.onStatus = onStatus || (() => {});
    this.watchId = null;
    this.lastRaw = null;
  }

  get running() { return this.watchId !== null; }

  start() {
    if (this.running) return;
    if (!('geolocation' in navigator)) { this.onStatus({ error: '此浏览器不支持定位' }); return; }
    if (!window.isSecureContext) this.onStatus({ error: '需要 HTTPS 才能定位（请用 GitHub Pages 网址打开）' });
    // 第一次调用会弹出定位授权，所以必须在用户点击时调用
    this.watchId = navigator.geolocation.watchPosition(
      (pos) => this.handle(pos),
      (err) => {
        const msg = { 1: '定位权限被拒绝（设置 → 隐私与安全性 → 定位服务 → Safari 网站）', 2: '无法获取位置', 3: '定位超时' }[err.code] || err.message;
        this.onStatus({ error: msg, code: err.code });
        if (err.code === 1) this.stop();
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 }
    );
    this.onStatus({ started: true });
  }

  stop() {
    if (this.watchId !== null) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
    this.onStatus({ stopped: true });
  }

  handle(pos) {
    const c = pos.coords;
    const { x, y } = this.resort.proj.toXY(c.latitude, c.longitude);
    const devSpeed = c.speed != null && !isNaN(c.speed) && c.speed >= 0 && c.accuracy <= 50 ? c.speed : null;
    this.lastRaw = { lat: c.latitude, lon: c.longitude, acc: c.accuracy, t: pos.timestamp };
    this.onFix({ t: pos.timestamp, x, y, acc: c.accuracy, speed: devSpeed, source: 'gps' });
  }
}

// 屏幕常亮（与 HUD 相同）：只能减少自动锁屏，不能让网页在锁屏后继续运行
export class WakeLock {
  constructor() { this.lock = null; this.state = 'off'; this.want = false; }
  async request() {
    this.want = true;
    if (!('wakeLock' in navigator)) { this.state = 'unsupported'; return; }
    if (this.lock || document.visibilityState !== 'visible') return;
    try {
      this.lock = await navigator.wakeLock.request('screen');
      this.state = 'on';
      this.lock.addEventListener('release', () => { this.lock = null; this.state = 'off'; });
    } catch { this.state = 'failed'; }
  }
  release() { this.want = false; this.lock?.release(); this.lock = null; this.state = 'off'; }
}
