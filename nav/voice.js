// 语音适配层。导航逻辑只调用 speak()，不关心具体实现。
// 以后换成原生 iOS（AVSpeechSynthesizer，可在后台/锁屏时通过音频会话播报）时，
// 实现同样的接口即可：{ available, enabled, speak(text, lang), cancel(), test(lang) }

export class WebSpeechVoice {
  constructor() {
    this.synth = typeof window !== 'undefined' ? window.speechSynthesis : null;
    this.enabled = true;
    this.voices = [];
    this.lastError = null;
    if (this.synth) {
      const load = () => { this.voices = this.synth.getVoices(); };
      load();
      this.synth.addEventListener?.('voiceschanged', load);
    }
  }

  get available() { return !!this.synth && typeof SpeechSynthesisUtterance !== 'undefined'; }

  pickVoice(lang) {
    const want = lang === 'ja' ? /^ja/i : /^zh/i;
    const list = this.voices.filter((v) => want.test(v.lang));
    // 普通话优先于粤语/台湾腔
    return list.find((v) => /zh[-_]CN/i.test(v.lang)) || list.find((v) => v.localService) || list[0] || null;
  }

  hasVoiceFor(lang) { return !!this.pickVoice(lang); }

  // 导航提示总是最新的最重要：新提示打断正在播的旧提示
  speak(text, lang = 'zh', { interrupt = true } = {}) {
    if (!this.enabled || !this.available || !text) return false;
    try {
      if (interrupt) this.synth.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = lang === 'ja' ? 'ja-JP' : 'zh-CN';
      const v = this.pickVoice(lang);
      if (v) u.voice = v;
      u.rate = 1.05;
      u.onerror = (e) => { this.lastError = e.error || 'error'; };
      this.synth.speak(u);
      return true;
    } catch (e) {
      this.lastError = e.message;
      return false;
    }
  }

  cancel() { try { this.synth?.cancel(); } catch { /* 忽略 */ } }

  // iPhone 上必须在用户点击里先说一句，之后才能自动播报
  test(lang = 'zh') {
    return this.speak(lang === 'ja' ? '音声テストです。この先分岐、左へ進んでください' : '声音测试。前方分岔靠左，进入五号雪道', lang);
  }
}

// 没有语音时使用：只返回 false，界面会改用醒目的文字提示
export class SilentVoice {
  constructor() { this.enabled = false; }
  get available() { return false; }
  speak() { return false; }
  cancel() {}
  test() { return false; }
}
