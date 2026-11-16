# AGENTS.md

## 网络代理

本机访问 GitHub / `raw.githubusercontent.com` 等外网需要走本机 SOCKS5 代理：

- 代理地址：`socks5h://127.0.0.1:10810`
- curl：`curl --proxy socks5h://127.0.0.1:10810 ...`
- git：`git -c http.proxy=socks5h://127.0.0.1:10810 push ...`（或 `git config --global http.proxy socks5h://127.0.0.1:10810`）

无需再向用户确认代理地址。

## 部署

本站是 GitHub Pages（`lbj.xanyi.eu.org`），从 `main` 分支根目录发布。改动只有 commit + push 到 `main` 后才会在线上生效，通常 1–2 分钟重建；验证线上效果前先确认已推送。
