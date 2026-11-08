// 把“航空照片核对页”里的人工标记写回雪场地图。
//   ok（对的）     → 推算连接不再“不确定”（attr.evidence = review）
//   blocked（走不通）→ 这条边 open = false（规划时避开），attr.open = review
//   shift / name / missing → 需要人工改几何或名字：列进待办，不自动改
// marks：[{ resort, kind: edge|fork|point, target, status, note, lat, lon, at }]
export function applyReview(resortJson, marks) {
  const mine = marks.filter((m) => m.kind === 'edge' && m.target);
  const byEdge = new Map();
  for (const m of mine.sort((a, b) => (a.at || '').localeCompare(b.at || ''))) byEdge.set(m.target, m);   // 同一条边以最后一次标记为准
  let confirmed = 0, closed = 0;
  for (const e of resortJson.edges) {
    const m = byEdge.get(e.id);
    if (!m) continue;
    if (m.status === 'ok') {
      if (e.uncertain) confirmed++;
      e.uncertain = false;
      e.attr = { ...(e.attr || {}), evidence: 'review' };
    } else if (m.status === 'blocked') {
      e.open = false;
      e.attr = { ...(e.attr || {}), open: 'review' };
      e.note = `${e.note ? e.note + '；' : ''}人工核对：走不通${m.note ? '（' + m.note + '）' : ''}`;
      closed++;
    }
  }
  const todo = marks.filter((m) => ['shift', 'name', 'missing'].includes(m.status))
    .map((m) => ({ status: m.status, kind: m.kind, target: m.target || null, note: m.note || '', lat: m.lat, lon: m.lon }));
  resortJson.importReport = { ...(resortJson.importReport || {}), review: { marks: marks.length, confirmed, closed, todo } };
  return resortJson;
}
