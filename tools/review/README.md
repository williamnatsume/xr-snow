# 航空照片核对页（雪人地图核对）

在线页面（私有，用户本人可打开）：https://claude.ai/artifact/LzvGDQ4kYZJ3bTEbJMf2V4

页面把国土地理院シームレス空中写真（zoom 17，拼接加工）、OSM 雪道 / 缆车、推算连接（是否有公开轨迹佐证）、岔口叠在一起；
用户点线或岔口标记“对的 / 画歪了 / 走不通 / 名字不对”，或在地图上标“缺的路”。标记存在页面的共享存储（collection `marks`）。

## 重新生成
```bash
node tools/export-review.mjs resorts/kagura-osm.json <out>/data/kagura.json
swift tools/gsi-mosaic.swift <south> <west> <north> <east> 17 <out>/img kagura   # 范围用导出 JSON 里的 bounds
# 把 Leaflet 1.9.4 的 CSS 内联到 page.src.html 的 /*LEAFLET_CSS*/（Artifact 只允许 CDN 脚本，样式要内联），存成 <out>/index.html
# 用 Artifact 工具发布 index.html，files 带上 data/*.json 和 img/*（capabilities: db + user）
```

## 把标记写回地图
1. `ArtifactData` list `marks`（out_dir 导出成 JSON 文件）
2. `node tools/apply-review.mjs <导出目录> kagura` → `data/osm/kagura-review.json`
3. `node tools/import-osm.mjs`（自动应用：对的 → 去掉“不确定”；走不通 → open=false；画歪 / 名字 / 缺的路 → 打印待办，需要手工改）
