<p align="center">
  <img src="build/icon.png" alt="红果短剧 Mac 应用图标" width="112" height="112">
</p>

<h1 align="center">红果短剧 · Mac 短剧播放器与下载器</h1>

<p align="center">
  在 Mac 上发现短剧、按集下载、接着观看，把已下载的分集合并为一个视频。
</p>

<p align="center">
  <a href="https://github.com/XASDSdsa/hongguo-drama-mac/releases/tag/v1.1.12"><img alt="版本 1.1.12" src="https://img.shields.io/badge/release-v1.1.12-c8383d?style=flat-square"></a>
  <img alt="macOS 13 或更新版本" src="https://img.shields.io/badge/macOS-13%2B-252523?style=flat-square">
  <img alt="Apple Silicon arm64" src="https://img.shields.io/badge/Apple_Silicon-arm64-252523?style=flat-square">
  <a href="LICENSE"><img alt="GPL-3.0 许可证" src="https://img.shields.io/badge/license-GPL--3.0-555555?style=flat-square"></a>
  <img alt="v1.1.12 ad-hoc 签名，未公证" src="https://img.shields.io/badge/v1.1.12-ad--hoc%20signed-f0a04b?style=flat-square">
</p>

<p align="center">
  <a href="https://github.com/XASDSdsa/hongguo-drama-mac/releases/latest"><strong>下载 Mac 版</strong></a> ·
  <a href="https://github.com/XASDSdsa/hongguo-drama-mac">查看源码</a> ·
  <a href="https://github.com/XASDSdsa/hongguo-drama-mac/issues">反馈问题</a> ·
  <a href="#安装与开始使用">安装说明</a>
</p>

**红果短剧**是一款面向 Apple Silicon 的开源 Mac 短剧播放器与下载器。支持红果、西饭与河马来源的剧名搜索、选集下载和本地剧库，红果与西饭还提供分类浏览；播放进度、下载队列、视频处理与合并导出都在同一个桌面应用里管理。

这是社区维护的修改版本，**不是红果或西饭官方客户端，也未获平台官方背书**。Apple 公证是发行包的安全检查，不代表 App Store 审核或内容授权。

![红果短剧 Mac 播放器与下载器：v1.1.3 红果来源的分类、题材和海报目录](docs/screenshots/macos-browse.png)

<p align="center"><sub>v1.1.3 实际应用界面 · 红果来源</sub></p>

## 安装与开始使用

需要 **macOS 13 或更新版本、Apple Silicon（M 系列）Mac**。当前发行包为 arm64，应用已内置所需媒体工具，使用时无需安装 Node.js、Homebrew 或 FFmpeg。

1. 打开 [最新版本下载页](https://github.com/XASDSdsa/hongguo-drama-mac/releases/latest)，在 **Assets** 中下载 `.dmg` 安装包。当前版本文件名为 `hongguo-drama-1.1.12-mac-arm64.dmg`。
2. 打开 DMG，把「红果短剧」拖入「应用程序」，再从「应用程序」启动。
3. 在「设置」中选择下载目录；进入「发现短剧」选择来源，或在「搜索与下载」中查找剧名，打开详情后选择分集。

**v1.1.12 本次构建使用 ad-hoc 签名，未进行 Apple 公证。** 首次打开时请按 macOS 提示确认来源；发行页提供应用源码、FFmpeg/x264 对应源码及 DMG 的 SHA256 校验文件，方便核对下载文件。

## 从发现短剧到本地剧库

| 你要做的事 | 应用里的操作 |
|---|---|
| 找一部剧 | 按来源、分类与题材浏览海报，翻页查看目录，或直接搜索剧名。 |
| 只下载想看的集数 | 在详情中选择单集、多集或输入区间；例如 `1-10`、`1,3,5`。锁定集自动跳过。 |
| 管理下载进度 | 在下载管理中查看排队、进行中、完成和失败状态，暂停任务、重试失败项；并发数可在设置中调整。 |
| 更新剧集总数 | 在下载管理点“更新全部剧集”，逐部读取最新分集目录并显示上次更新时间；只更新信息，不会自动下载。 |
| 接着上次看 | 内置播放器记录分集和播放位置，支持本地播放、在线播放与自动连播。 |
| 制作可发布成品 | 进入下载管理点开一部短剧，按页面顶部的“下载 → 去重 → 分组/拼接 → 最终成品 → 发布素材”顺序操作。点击“去重处理本剧”会自动带入当前剧已下载且尚未处理的分集；完成后在同一页按范围或每 N 集生成成品。 |
| 处理本地视频 | “视频处理”仍支持独立文件模式；从某部短剧详情进入时会自动绑定该剧，输出到该剧的处理目录，不覆盖原文件。 |
| 整理磁盘空间 | 查看文件占用，删除单集或整部剧，清理转码缓存；也可扫描下载目录补登记已有文件。 |

### 先看，再决定下载

在「我的剧库」中，点击尚未下载且未锁定的分集可尝试在线播放，双击加入下载队列。开启连播后，未下载的可用分集会转为在线播放；锁定分集会跳过。

在线播放不保存到下载目录。部分片源需要先准备临时媒体文件，应用会在使用后清理。播放地址和可用清晰度由来源服务决定；遇到不兼容的媒体，可使用内置兼容转码。

播放器快捷键：`空格` 播放或暂停，`←` / `→` 后退或前进 5 秒，`↑` / `↓` 上一集或下一集，`A` 切换连播。

### 下载后，先在列表里完成去重

下载管理按短剧卡片分组。点进短剧后，上方是完整分集选择器，下方是该剧的视频列表；每个视频都会显示下载状态和去重状态。初次下载的视频明确显示“未去重”，点击视频列表表头的“一键去重”会只提交本剧已下载且尚未去重的文件，并在对应行显示排队、处理进度、完成或失败。

原始下载文件保留，去重输出写入独立的“处理后”目录。当前页面不再放置启动、暂停、重试、更多操作或合并成品入口，避免把下载状态和视频处理状态混在一起。

## 三个搜索来源，清楚的可用范围

![红果短剧 Mac 下载器：v1.1.3 西饭独立来源与真实剧集目录](docs/screenshots/macos-xifan.png)

<p align="center"><sub>v1.1.3 实际应用界面 · 西饭来源</sub></p>

| 来源 | 当前支持 | 使用边界 |
|---|---|---|
| **红果**（默认） | 分类与题材浏览、搜索、分享链接或剧集 ID 解析、可用分集播放与下载。 | 网页未提供片源时，会尝试补充接口取址；仍以服务实际返回为准。 |
| **西饭** | 独立目录、分页浏览、搜索、已开放分集播放与下载。 | 保留服务端锁定状态；锁定集不可选择、播放、转码或下载。 |
| **河马** | 剧名搜索、完整分集列表、官网明确免费的分集播放与下载；暂不提供分类浏览。 | 只有明确免费分集开放；收费或状态不明分集锁定，不使用加密取址回退。 |

三个来源的文件分目录保存，同名剧集不会互相覆盖。应用**不提供解锁功能**，也不会请求解锁或广告奖励接口；平台显示可看，不代表此应用必然能取得相同片源。

“漫画”是图文阅读内容，不是视频；需要视频类内容时，请选择“漫剧”。

## 当前版本与验证范围

[**v1.1.18**](https://github.com/XASDSdsa/hongguo-drama-mac/releases/tag/v1.1.18) 简化下载管理：移除剧集页的 AI 素材、合并、启动、暂停、重试和更多操作入口；视频列表表头提供一键去重，每个视频显示独立的去重状态和实时进度。原始下载和去重输出继续分目录保存。

[**v1.1.12 · 2026-10-11**](https://github.com/XASDSdsa/hongguo-drama-mac/releases/tag/v1.1.12) 下载管理按短剧封面卡片分组，点击卡片进入完整剧集详情页；上方显示封面、全部集数和下载状态，下方继续管理视频列表。支持区间选集、补下载、按范围或每 N 集分组合并；下载管理可一键更新全部已下载短剧的总集数，并显示每部剧上次更新时间。保留此前的视频处理响应与画质适配优化。

保留 1.1.5 的“全部来源”搜索，默认同时查询红果、西饭和河马，结果标明来源；单源失败保留其他结果。

河马使用官网公开接口，保留完整分集与收费状态；取播放地址、下载入队及缓存复用前都会重新核对可看范围。当前样本《出手》74 集，其中 5 集明确免费、69 集锁定；不承诺所有剧集或全部分集可用。西饭已聚合多个上游标识，本版不把它们重复列为独立来源。

保留 1.1.4 的全屏连播、续播与合并优化。新功能已通过搜索、跨来源选集、部分失败、重复提交、河马适配与锁定边界检查。

<details>
<summary>查看此前合并与播放验证结果</summary>

| 检查项 | 已验证结果 |
|---|---|
| 原生全屏连播 | 静音黑片自然播完，本地转在线准备、在线开始及再转本地，全程保持同一个全屏视频节点。 |
| 播放、下载与界面回归 | 播放 8 项、兼容生命周期 8 项、下载管理 8 项、界面状态 26 项通过；另完成下载安全、存储、解密与合并专项检查。 |
| 同编码兼容合并样本 | 7.906 秒降至 0.163 秒；约 96.83 MiB 降至 13.41 MiB。仅此样本，不代表混码或整部剧提速。 |
| 混合 H.264/HEVC 样本 | 总长约 153.5 秒、4604 帧完整解码；用时 8.800 秒与 8.704 秒基本相当，体积 109.77 MiB 降至 14.96 MiB。 |
| 发行包 | 应用与 DMG 使用 ad-hoc 签名，未进行 Apple 公证；发行附件提供 SHA256。 |

</details>

**验证边界：**仅有限样本；未进行主观画质盲评，转码并非无损。本轮没有重新合并整部 72 集，也未验收 Intel Mac 或 Windows。尚未在启用 Gatekeeper 的独立环境中复测安装体验。

## 常见问题

<details>
<summary><strong>可以在 Intel Mac 或 Windows 上使用吗？</strong></summary>

本分支目前只提供 Apple Silicon 的 Mac 安装包，没有发布 Intel Mac 构建。仓库保留 Windows 构建配置，但本分支未重新测试 Windows，不将其列为已支持的发行平台。

</details>

<details>
<summary><strong>为什么有的剧集锁定、无法下载，或者清晰度不同？</strong></summary>

可用分集、播放地址与分辨率取决于来源服务。西饭锁定集会保留锁定标记，选集和连播会跳过；应用不提供解锁，也不承诺付费内容可用或固定 1080p。红果补充取址同样不保证对每部剧有效。

</details>

<details>
<summary><strong>下载失败或目录加载不出来，先检查什么？</strong></summary>

先确认网络能访问来源平台，再检查「设置」中的代理模式：跟随系统、手动指定或强制直连。手动代理支持 HTTP/HTTPS；代理设置与实际网络不符可能导致取址或下载失败。适当降低下载并发数后重试，避免触发来源限流。

如果持续失败，请在 [Issues](https://github.com/XASDSdsa/hongguo-drama-mac/issues) 提供应用版本、macOS 版本、来源、操作步骤和错误提示。截图及日志请先移除账号信息、Cookie、代理凭据与个人文件路径。

</details>

<details>
<summary><strong>视频、任务和播放记录保存在哪里？</strong></summary>

视频保存到「设置」里选择的下载目录，按来源与剧名组织。设置、任务和播放记录默认位于 `~/Library/Application Support/hongguo-downloader/`；若自行通过启动参数指定数据目录，则以指定目录为准。

在线播放不等于下载完成。想长期保留文件，请使用下载功能；清理文件和清理转码缓存是不同操作，删除前请核对应用提示。

</details>

<details>
<summary><strong>源码构建和正式安装包的签名有什么不同？</strong></summary>

v1.1.12 本次发行包使用 ad-hoc 签名，未自动提交 Apple 公证。默认源码构建也使用 ad-hoc 签名，不会自动使用个人开发者证书。自行构建的应用可能需要在「系统设置 → 隐私与安全性」确认打开；请先核对来源，无需全局关闭 Gatekeeper。

</details>

## 从源码构建 Mac 版

<details>
<summary>展开构建步骤、产物位置与 FFmpeg 对应源码说明</summary>

应用使用 **Electron + React + Node.js**。构建需要 Node.js **22.12 或更新版本**、npm、Apple Command Line Tools、`pkg-config`，以及可用的 `make`、`git`、`curl`。构建脚本不会自动安装这些系统依赖。

```sh
git clone https://github.com/XASDSdsa/hongguo-drama-mac.git
cd hongguo-drama-mac
npm ci
npm run build:mac
```

构建会验证已有 FFmpeg / FFprobe 缓存；缺少匹配缓存时，从固定且经过 SHA256 校验的 FFmpeg/x264 源码编译，然后生成前端、arm64 应用和 DMG。首次构建需联网获取依赖和源码，编译可能耗时数分钟。

| 用途 | 命令或产物 |
|---|---|
| 开发模式 | `npm run dev` |
| 仅生成 Mac 应用 | `npm run build:mac:dir` |
| 应用产物 | `dist/mac-arm64/红果短剧.app` |
| v1.1.12 DMG | `dist/红果短剧-1.1.12-mac-arm64.dmg` |

### FFmpeg 的准确对应源码

Mac 包内置的 FFmpeg / FFprobe 基于 **FFmpeg 9.0.2** 与 **x264 `b35605ace3ddf7c1a5d67a2eb553f034aef41d55`** 的未修改源码编译。此构建为 **GPLv3-or-later**，仅静态链接 x264，保留 VideoToolbox，未启用 `nonfree`；动态依赖仅为 macOS 系统库，不依赖使用者的 Homebrew 环境。

[对应版本的 Release](https://github.com/XASDSdsa/hongguo-drama-mac/releases/tag/v1.1.12) 附有**应用源码 ZIP**以及独立的 **FFmpeg/x264 完整对应源码包**，后者包含准确源码归档、构建脚本、清单与许可文本。只下载 GitHub 自动生成的项目源码归档，不能代替这一媒体工具对应源码包。

- [FFmpeg 来源、源码校验值与构建说明](build/ffmpeg/MACOS-NOTICE.txt)
- [准确版本与构建配置](build/ffmpeg/MACOS-VERSIONS.txt)
- [FFmpeg 源码构建脚本](scripts/build-ffmpeg-source-mac.sh)
- [FFmpeg GPLv3 许可全文](build/ffmpeg/MACOS-LICENSE.txt) · [x264 许可全文](build/ffmpeg/MACOS-X264-LICENSE.txt)

FFmpeg 二进制不提交到 Git。重新分发编译包时，请按 GPL 要求同时提供完整对应源码及构建材料。

</details>

## 上游、许可证与使用边界

本项目延续上游的 **[GPL-3.0](LICENSE)** 许可，并保留修改与来源声明。Mac 分支自 2026-10-07 开始适配，详细变更见 [NOTICE](NOTICE)，组件许可见 [第三方声明](THIRD-PARTY-NOTICES.md)。

感谢以下项目提供的基础工作与参考：

- **[327044572/hongguo-downloader](https://github.com/327044572/hongguo-downloader)**：原始上游项目。
- **[zhenyong97/hongguo-downloader](https://github.com/zhenyong97/hongguo-downloader)**：本次 Mac 移植的直接基础。
- **[woshishiq1/drpys](https://github.com/woshishiq1/drpys)** 与 **[N3urda/hongguoTV](https://github.com/N3urda/hongguoTV)**：App 片源相关算法来源；准确提交与修改说明见 [算法来源声明](src/native/licenses/NOTICE.txt)。
- **[Hululu007/drpy-node](https://github.com/Hululu007/drpy-node/tree/295f2b7047e14122d542a7736cb931e81abcf85c)**：西饭接口路径与返回结构参考；本项目独立编写适配器。
- **Electron、React、FFmpeg 与 x264**：桌面运行、界面和媒体处理组件，许可详情见上述声明。

开源许可适用于软件，不授予剧集内容的再分发权。安装包不包含剧集媒体；作品版权归原平台及创作者所有。请仅处理你有权访问、下载或备份的内容，遵守平台条款与相关法律，勿用于未经授权的传播或商业盗版。平台接口可能调整，某次验证通过不保证后续片源持续可用。
