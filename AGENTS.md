# AGENTS.md

## 网络代理

本机访问 GitHub / `raw.githubusercontent.com` 等外网需要走本机 SOCKS5 代理：

- 代理地址：`socks5h://127.0.0.1:10810`
- curl：`curl --proxy socks5h://127.0.0.1:10810 ...`
- git：`git -c http.proxy=socks5h://127.0.0.1:10810 push ...`（或 `git config --global http.proxy socks5h://127.0.0.1:10810`）

无需再向用户确认代理地址。

但 2026-11 实测本机全局 `http.proxy` 是 `127.0.0.1:10809`，走它推送会
`OpenSSL SSL_connect: SSL_ERROR_SYSCALL`；直连反而能通，用
`git -c http.proxy= -c https.proxy= push origin main`。推不通时先去掉代理再试一次。

## 部署

本站是 GitHub Pages（`lbj.xanyi.eu.org`），从 `main` 分支根目录发布。改动只有 commit + push 到 `main` 后才会在线上生效，通常 1–2 分钟重建；验证线上效果前先确认已推送。

## 固件归档

`archive/` 下 K5/K6 V1 的 `k5lbj-*.bin` / `k5tdcs-*.bin` 一律发布 packed 镜像
（k5-f4 的构建产物 `f4hwn.*.packed.bin`：`0x2000` 插 16 字节版本块、全镜像 XOR、
末尾 CRC16）。页面用 `js/k5-firmware.js` 识别并先解包再写，所以文件名和版本号不变，
不要加 `-packed` 后缀，否则 `catalog.js` 会出现重复版本。LBJRADIO 的 K1 镜像走
7.00.07 DFU，保持 raw。

版本后缀必须带分隔符：`js/catalog.js` 的 `splitVersionedName()` 只在 `v<版本>`
后面紧跟 `.` / `_` / `-` 时才认后缀，`...v5.6.11dev.bin` 会被解析成版本 5.6 +
后缀 `.11dev`，在列表里排到 5.6.10 之下；写成 `...v5.6.11-dev.bin` 才是 5.6.11。

## 校准字段表

`js/calibration-fields.js` 把校准备份读到的 512 字节逐字段解码，K1（`0xB000`，物理
`0x010000`）和 K5/K6 V1（`0x1E00`）共用同一张表，块内偏移一样，只有基址不同。
字段名和偏移来自固件 `SETTINGS_LoadCalibration()` 与这套固件的 CHIRP 模块，
改字段先核对那两处。页面是中文单语，文案直接写在模块里，不经过 `locales/`。
