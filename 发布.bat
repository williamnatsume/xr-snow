@echo off
rem 双击运行：把 XR SNOW 文件夹里的改动提交并推送到 GitHub，GitHub Pages 会自动重新发布
chcp 65001 >nul
cd /d "%~dp0"
git add -A
git commit -m "更新 %date% %time%"
git push
echo.
echo 已推送。大约 1 分钟后网页更新（手机上下拉刷新；如仍是旧版，稍等几分钟缓存过期）。
pause
