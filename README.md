# LBJ 车次日志 · 网页版导出工具

`tools/lbj_log.py` 的浏览器版本：用 **Web Serial** 直接连对讲机，把外部 flash
`0x018000..0x01FFFF`（1024 条 × 32 字节）里的 LBJ 车次日志读回来，在页面上列成表格，
导出 CSV 或原始 32 KiB 镜像。

同一个页面还提供另外三个工具页（外观与 UV Studio 一致）：

| 侧栏 | 作用 |
| --- | --- |
| **LBJ 车次日志** | 读取 / 导出车次日志（本页只读） |
| **刷固件** | DFU 模式整机刷写固件（会覆盖主固件） |
| **多固件** | 把多个固件写进外部 flash 的插槽，开机按住 `MENU` 选择 |
| **管理安装 APP** | 把 `.app` 覆盖程序装进外部 flash 的应用槽，电台 `F + 7` 菜单启动 |

页面外观、布局、串口连接方式**照搬 UV Studio**（`armel.github.io/uvstudio`）：同一套
顶栏 / 侧栏 / 状态胶囊 / 主题切换 / 语言选择 / 表格 / 进度条 / Console，同一套
`0x0514` 握手，以及同样的重试与地址校验。**LBJ 车次日志不需要任何固件改动**
（`0x0738` 由 `ENABLE_FEAT_F4HWN_EXT_FLASH_RW` 提供，Fusion / LBJRadio 预设已开启）。

## 打开

用桌面版 **Chrome / Edge / Opera** 打开 `index.html`
（双击即可，`file://` 也能用 Web Serial；`http://localhost` 亦可）。

- 先把 UV Studio / K5Viewer 关掉 —— 串口同一时刻只能被一个页面占用。
- 用 K 头写频线连接电台。
- 车次日志、多固件、APP 都在电台正常开机状态下操作；刷固件需要先进入 DFU 模式
  （按住 `PTT` 开机）。
- 四个页面通过地址栏 hash 切换：`#lbj-log`、`#flash`、`#slots`、`#apps`。

### LBJ 车次日志

点 **读取车次日志**，在浏览器弹窗里选中电台的串口。读完后页面上会出现两个下载链接：

| 下载 | 内容 |
| --- | --- |
| `lbj-log.csv` | 与 `lbj_log.py` 逐字节一致的 CSV（UTF-8 BOM + CRLF）；界面语言为中文时表头用中文 |
| `lbj-log.bin` | 原始 32 KiB，可直接喂给 `python tools/lbj_log.py --raw` 或离线分析 |

表格上方的输入框可按 **车次** 或 **车号** 筛选（纯前端过滤，不影响导出内容）。
**本页只读**，不提供清空日志的功能（要清空请用固件菜单里的 `LBJCLR`，或
`python tools/lbj_log.py --clear`）。

### 刷固件

1. 点 **选择固件**，从在线列表或本地文件里挑一个 `.bin`；
2. 电台按住 `PTT` 开机进入 DFU，然后点 **刷写**；
3. 页面等待 bootloader 广播（`0x0518`）、完成握手（`0x0530`），再按页写入
   （`0x0519`），最后重启电台。

固件列表来自项目归档站的 `archive/` 目录（GitHub Contents API，10 分钟缓存）；
也可以直接用本地文件。最低 bootloader 版本 `7.00.07`，低于此版本页面会拒绝刷写。

### 多固件

1. 点 **刷新插槽** 读取 4 个用户插槽（`0x0720`）；
2. 选择固件（在线列表或本地 `.bin`）、目标插槽和显示名称；
3. 点 **写入插槽**（`0x0722` 擦除 → `0x0724` 分块写入 → `0x0726` 校验）。

只写外部 flash，不会影响电台主固件。单个镜像上限 118 KiB。插槽里的固件开机时按住
`MENU` 选择；插槽行还提供 **擦除** 和 **重置配置**（`0x0728`）。

### 管理安装 APP

1. 点 **刷新应用** 读取应用槽（`0x0730`），页面会自动判断是 16 槽还是 48 槽固件；
2. 在版本下拉框里选一个 `.app`（来自归档站 `archive/apps/`，也可用本地文件）；
3. 选目标槽位，点 **安装 / 更新**（`0x0732` 擦除 → `0x0734` 分块写入 →
   `0x0736` 校验）。

已安装列表显示名称、应用版本、代码 / 资源大小和状态；支持逐槽 **删除** 与
**全部删除**。只写外部 flash，安装后在电台的 `F + 7` 菜单里启动。

## 记录格式

与 `tools/lbj_log.py`、`App/app/lbj_log.c` 完全一致（32 字节，小端）：

```
[0]      flags   b0..b6 = 车次/速度/公里标/车型/车号/线路/距离 有效（b7 保留）
[1..2]   车次前缀（ASCII）
[3..5]   车次数字 6 位 BCD（半字节 0xF = 缺）
[6..7]   速度 u16（0xFFFF = 未知）
[8..10]  公里标 u24（0.1 km，0xFFFFFF = 未知）
[11..12] 车型码 u16（0xFFFF = 未知）
[13..16] 车号 8 位 BCD（半字节 0xF = 缺）
[17..20] 线路 4 个 ASCII（拼音首字母）
[21..22] 距离 i16（0.1 km，<0 = 未知）
[23]     方向（0 = 未知，1 = 下行 DN，2 = 上行 UP）
[24..25] sequence u16
[26..27] uptime u16
[28..29] 保留（0xFF）
[30]     CRC8（前 30 字节，初值 0x5A，多项式 0x31）
[31]     commit = 0xA5（最后写入，才算一条完整记录）
```

## 文件

```
index.html            UV Studio 外壳 + 四个工具视图
css/{core,studio,tools}.css   原样内置自 UV Studio（见下"来源"）
css/lbj-log.css       本页自己的少量样式（宽屏/窄屏表格、等宽数字、列表工具栏）
js/studio-preferences.js      原样内置
js/studio-i18n.js             原样内置（data-i18n 机制）
js/studio-serial.js           原样内置（串口所有权仲裁）
js/ui.js              外壳接线：Console / 进度条 / 状态胶囊 / 主题 / hash 路由 / 确认框
js/serial.js          串口协议：连接 + 0x0514 + 0x0738/0x0739 + 插槽 / APP / DFU 命令
js/lbj-log.js         纯模块：32 字节记录解析 + CRC8 + CSV（可选 Node CLI）
js/radio-format.js    纯模块：CRC32、FMB1 插槽头、FAP1 应用头、版本比较
js/catalog.js         纯模块：归档站目录（GitHub Contents API）+ 缓存 + 分组 + 下载
js/app.js             LBJ 车次日志视图
js/view-flash.js      刷固件视图
js/view-slots.js      多固件视图
js/view-apps.js       管理安装 APP 视图
js/*.test.js          Node 自测（node --test）
locales/{zh,en}.js    内置自 UV Studio，并在结尾追加本页新增的键
```

没有内置 `viewer.css` 和上游的 `flash.js`：K5Viewer 屏幕、射频日志、Logo 等与本页无关。

## 来源（vendored）

内置资源取自 **UV Studio v2.0.0**，仓库 `armel/armel.github.io`，目录 `uvstudio/`：

| 本地文件 | 上游 | 版本参数 |
| --- | --- | --- |
| `css/core.css` | `css/core.css` | `?v=5` |
| `css/studio.css` | `css/studio.css` | `?v=26` |
| `css/tools.css` | `css/tools.css` | `?v=57` |
| `js/studio-preferences.js` | `js/studio-preferences.js` | `?v=2` |
| `js/studio-i18n.js` | `js/studio-i18n.js` | `?v=5` |
| `js/studio-serial.js` | `js/studio-serial.js` | `?v=2` |
| `locales/en.js` | `locales/en.js` | `?v=63` |
| `locales/zh.js` | `locales/zh.js` | `?v=63` |

上表这些都是**逐字节原样**的，只有两个 locale 在文件**结尾追加**了本页新增的键
（原来的键一个没改）。要跟着上游升级：重新下载同名文件，再把结尾的新键块拼回去即可。
`css/lbj-log.css` 是本页新加的，不来自上游。

不是原样内置、而是**改编**的上游文件：

| 本仓库 | 上游 | 版本参数 |
| --- | --- | --- |
| `js/serial.js` | `js/flash.js`（连接 / 0x0514 / 0x0738/0x0739 / 插槽 / APP / DFU） | `?v=84` |
| `js/ui.js` | `js/studio.js`（状态胶囊、路由）+ `js/studio-serial.js`（操作锁） | `?v=19` / `?v=2` |
| `js/view-flash.js` | `js/flash.js`（DFU 刷写流程） | `?v=84` |
| `js/view-slots.js` | `js/flash.js`（多固件插槽流程） | `?v=84` |
| `js/view-apps.js` | `js/flash.js` + `js/app-catalog.js`（应用槽流程） | `?v=84` / `?v=20` |
| `js/catalog.js` | `js/flash-catalog.js` + `js/app-catalog.js`（在线列表） | `?v=19` / `?v=20` |
| `js/lbj-log.js` + `js/lbj-log.test.js` | `js/rf-log.js` + `tests/rf-log.test.js`（UMD 模块 + node:test 写法） | `?v=4` |

## 在线固件 / APP 目录

固件列表来自归档站的 `archive/`，APP 列表来自 `archive/apps/`，两者都通过 GitHub
Contents API 读取，因此不需要额外的清单文件：

- 文件名里的版本号（如 `LBJRADIO.v5.5.0.bin`）用来分组和排序；
- 列表缓存在 `localStorage` 10 分钟，过期后先用旧缓存、后台再刷新；
- 未认证的 GitHub API 每小时 60 次；触顶后页面会暂停请求，等 `x-ratelimit-reset`
  之后自动恢复，同时继续使用缓存；
- 下载直连归档站的静态文件（`archive/...`），不经过 API；
- 没有网络或 API 不可用时，三个工具页都仍然可以选本地文件。

## 自测

```sh
node --test js/lbj-log.test.js js/catalog.test.js js/radio-format.test.js
node --check js/serial.js
```

覆盖：CRC8 固件向量、几何常量、全字段解析、方向三态、缺字段哨兵、未知车型码、
未知距离、CRC 失败、commit 未写、整块扫描与空槽/坏记录计数、CSV（BOM/表头/CRLF/排序/引号）；
以及 CRC32、FMB1 / FAP1 头的构造与解析、版本比较、文件名分组与筛选。

也可以用 CLI 把一份已 dump 的镜像直接转成 CSV，用来和 Python 版逐字节对比：

```sh
node js/lbj-log.js zone.bin -o js.csv
python tools/lbj_log.py --raw zone.bin -o py.csv
cmp js.csv py.csv            # 应完全一致（中文表头用 --chinese）
```

## 真机验证

需要在电台 + K 头写频线上手动点一次（本页无法在无硬件环境里自动化验证）。建议：

1. 固件菜单里打开 `LBJLOG`，等解到几列车；
2. 打开本页 → 读取车次日志 → 表格里应出现这些车次；
3. 导出 CSV，与 `python tools/lbj_log.py --port COMx -o py.csv` 的结果对比应完全一致。
4. 多固件：写入一个插槽 → 刷新应显示「有效」→ 开机按住 `MENU` 应能启动它。
5. APP：装一个 `.app` → 列表里应出现名称和版本 → 电台 `F + 7` 菜单应能启动。
6. 刷固件：DFU 刷写后电台应正常重启，版本号与所选文件一致。

---

*LBJ Log is a small companion page for this firmware repo. Its look, page layout
and serial connection deliberately follow UV Studio (armel/armel.github.io) so it
behaves like a familiar UV Studio tab; the LBJ zone walk, the slot / app managers
and the record parser are new. Vendored UV Studio assets are kept verbatim and
stay under their original licence.*
