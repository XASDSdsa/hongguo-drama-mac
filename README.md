<p align="center">
  <img src="build/icon.png" alt="红果短剧 Mac 应用图标" width="112" height="112">
</p>

<h1 align="center">红果短剧 · Mac 短剧播放器与下载器</h1>

<p align="center">
  在 Mac 上发现短剧、按集下载、接着观看，把已下载的分集合并为一个视频。
</p>

<p align="center">
  <a href="https://github.com/XASDSdsa/hongguo-drama-mac/releases/tag/v1.1.30"><img alt="版本 1.1.30" src="https://img.shields.io/badge/release-v1.1.30-c8383d?style=flat-square"></a>
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

1. 打开 [最新版本下载页](https://github.com/XASDSdsa/hongguo-drama-mac/releases/latest)。Windows 下载 `hongguo-downloader-1.1.30-Setup.exe`，免安装用同版本的 `portable.exe` 或 `win-x64.zip`。Mac 下载 `hongguo-downloader-1.1.30-mac-arm64.dmg`。解压或安装后即可使用，不需要另装 Python。
2. 打开 DMG，把「红果短剧」拖入「应用程序」，再从「应用程序」启动。
3. 在「设置」中选择下载目录；进入「发现短剧」选择来源，或在「搜索与下载」中查找剧名，打开详情后选择分集。

**v1.1.30 的 Mac 构建使用 ad-hoc 签名，未进行 Apple 公证。** 首次打开时请按 macOS 提示确认来源；发行页提供应用源码、FFmpeg/x264 对应源码及 DMG 的 SHA256 校验文件，方便核对下载文件。

## 从发现短剧到本地剧库

| 你要做的事 | 应用里的操作 |
|---|---|
| 找一部剧 | 按来源、分类与题材浏览海报，翻页查看目录，或直接搜索剧名。 |
| 只下载想看的集数 | 在详情中选择单集、多集或输入区间；例如 `1-10`、`1,3,5`。锁定集自动跳过。 |
| 管理下载进度 | 在下载管理中查看排队、进行中、完成和失败状态，暂停任务、重试失败项；并发数可在设置中调整。 |
| 更新剧集总数 | 在下载管理点“更新全部剧集”，逐部读取最新分集目录并显示上次更新时间；只更新信息，不会自动下载。 |
| 接着上次看 | 内置播放器记录分集和播放位置，支持本地播放、在线播放与自动连播。 |
| 批量去重已下载视频 | 在下载管理点开短剧，点击视频列表表头的“一键去重”；只处理已下载且未去重的分集，各行实时显示状态与进度。 |
| 处理本地视频 | “视频处理”仍支持独立文件模式；从某部短剧详情进入时会自动绑定该剧，输出到该剧的处理目录，不覆盖原文件。 |
| 整理磁盘空间 | 查看文件占用，删除单集或整部剧，清理转码缓存；也可扫描下载目录补登记已有文件。 |

### 先看，再决定下载

在「我的剧库」中，点击尚未下载且未锁定的分集可尝试在线播放，双击加入下载队列。开启连播后，未下载的可用分集会转为在线播放；锁定分集会跳过。

在线播放不保存到下载目录。部分片源需要先准备临时媒体文件，应用会在使用后清理。播放地址和可用清晰度由来源服务决定；遇到不兼容的媒体，可使用内置兼容转码。

播放器快捷键：`空格` 播放或暂停，`←` / `→` 后退或前进 5 秒，`↑` / `↓` 上一集或下一集，`A` 切换连播。

### 下载后，先在列表里完成去重

下载管理按短剧卡片分组。点进短剧后，上方是完整分集选择器，下方是该剧的视频列表；每个视频都会显示下载状态和去重状态。初次下载的视频明确显示“未去重”，点击视频列表表头的“一键去重”会只提交本剧已下载且尚未去重的文件，并在对应行显示排队、处理进度、完成或失败。

视频列表表头可直接选择 1～8 个并发去重任务，与“视频处理”页共用并保存该设置。界面分别显示实际处理中和等待数量，每条视频独立更新进度。提高并发立即补充等待任务；降低并发会等待现有任务完成，不中断视频。多个批次共享全局 8 个处理槽位；运行期间也可追加新下载的视频。

除下载时按剧名建一个文件夹外，目录完全由你指定，程序不会再自动建“来源/ID摘要/阶段”之类的子文件夹，也不会按目录去猜哪些文件属于哪部剧。在“设置”里选择：

- **下载目录**：每部剧在这里建一个以剧名命名的文件夹，视频保存在里面。
- **去重输出目录**：去重成品保存在这里（“视频处理”页也可临时指定，留空则用设置里的目录）。
- **拆解输出目录**：视频结构化拆解的结果保存在这里。
- **合集输出目录**、**AI 素材输出目录**：合并成片、AI 封面与文案分别保存在这里。

某个输出目录没有选择时，对应功能会直接提示先选择。字幕、分析等中间文件保存在应用自己的数据目录，不会写进你的输出目录。

### 管理剧集

“管理剧集”把一个文件夹当作一部剧：列出下载目录下的剧文件夹，也可以用“导入已有剧”选任意文件夹（只记路径，不改动、不删除里面的文件）。下载一部剧时，会顺手把来源平台的封面和简介存进剧文件夹（`封面.jpg/png/webp`、`简介.txt`），已有的文件不会被覆盖；不同来源的两部剧同名时，后来的文件夹自动加来源后缀。

点开一部剧，弹窗里按文件夹中实际存在的视频列出各集（不依赖下载记录），选中要处理的集后有两种去重方式：

- **重新拆分**（默认）：先裁掉每集片头片尾，再把选中的集按集号接成一条时间线，按“成品时长范围”重新切成新的集，最后逐集去重。切点优先落在镜头切换、说话停顿和原集交界处；每集的变速倍数在设定范围内取，并按成品时长倒推，所以成品时长一定落在范围里。结果放进 `剧文件夹/去重/`，命名为 `剧名_第001集.mp4`。
- **按原集去重**：一集出一集，结果同样放进 `剧文件夹/去重/`。

重新拆分会先看选中的集之间缺了哪几集，并在卡片里用虚线占位标出原因：**平台无此集**、**已锁定未解锁**（来源本来就没有，下载不了）默认直接拼接，只在结果里提示；**没下载 / 下载中 / 下载失败**（平台有、还能补）会弹窗让你选“先补下载，下完自动继续处理”或“不管，强制拼接”；**导入的文件夹**软件不知道缺的是哪种，会问一次“本来就缺，直接拼”，确认后记住。缺口处切点会优先落在两集之间。

参数面板分“时间与速度”（成品时长、片头片尾裁剪、变速范围）和“画面参数”。切点分析结果缓存在应用的数据目录里，不进你的文件夹。

### AI 发布素材（简介 / 剧名 / 海报）

在“管理剧集”里打开一部剧，顶部有“AI 发布素材”面板，一键完成三步，结果直接放进剧文件夹：

1. **改写简介和剧名**：一次文本调用，同时给出改写后的简介、5 个候选剧名、题材、标题样式、海报角标和画面描述。候选剧名由程序按规则排序（长度、是否有钩子、不与原名雷同、不含“最”“第一”等绝对化用语），第一名自动采用，也可以在面板里换。
2. **重画海报底图**：用图像模型以 `封面.*` 为参考重绘（没有封面就按画面描述生成），**要求画面里不出现任何文字**，下方三分之一留空。随后让视觉模型检查画面有没有文字、人脸在哪；有字就重画（最多 3 次），模型不支持看图时跳过检查。
3. **程序排版标题**：标题不交给图像模型画（中文容易错字、位置不稳），而是用打包的字体在画布上渲染：8 套样式（鎏金霸总、烈焰逆袭、古风朱墨、冷光悬疑、糖果甜宠、血色复仇、紫金玄幻、都市硬朗），由文本模型按题材挑选。位置由程序算：把底图缩小后比较下/上/中三条候选带的画面复杂度、肤色占比和人脸重叠，选最空的；再按底图亮度铺暗角，保证对比度。

结果为 `发布剧名.txt`、`发布简介.txt`、`发布海报.jpg`。无字底图和状态放在应用私有目录，所以之后换剧名、样式、角标只是重新排版，不再调用模型。

设置页的“AI 发布素材”可填 OpenAI 兼容的中转地址和 Key；文本和作图可以各用一组（作图留空则共用文本那组）。默认文本模型 `gpt-6.1-sol`、图片模型 `gpt-image-2.5`，都可以改成中转站支持的其他模型。海报字体取自 Fontsource（OFL 1.1），构建时由 `npm run setup:title-fonts` 准备。

### 去重后识别完整字幕

“完整字幕识别”只读取已完成去重的视频。内置 faster-whisper 在本地识别全部音轨并做词级对齐；音频的起点、空档和长度按去重视频的实际时间轴校正。每集只保存一个 SRT，不另存转写 JSON/TXT，不自动生成文案。

字幕任务共享设置中的全局并发额度（1～4），各剧独立排队、停止和记录状态。视频列表显示“校正音频时间轴 → 识别并对齐 → 校验字幕时间轴”的进度；点击停止会等待子进程退出后再允许重试。批量入队只保存一次状态，进度更新不反复写磁盘。

保存前检查字幕编号、时间格式、正时长、顺序、重叠及视频边界，并按音轨实际起止位置纠正落入补零区的字幕边界。通过校验后才替换正式 SRT 并标为完成；源视频改变、字幕丢失、清空或内容变化后，需要重新识别，下游也不能继续使用旧字幕。静音和画面留白保留原时间，不拉伸最后一句补满视频。

时间轴校验不等于人工逐字审校。自动识别可能有错字或漏词，词级对齐仍可能有误差，不能保证每句都在 0.1 秒内。开发检查：`npm run check:subtitles`、`python scripts/check-subtitle-alignment.py`；构建机需先准备项目内置 FFmpeg，用户安装包自带引擎和模型。

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

[**v1.1.30**](https://github.com/XASDSdsa/hongguo-drama-mac/releases/tag/v1.1.30) 同时发布 Windows 安装包和 Mac arm64 DMG。字幕按剧隔离、词级对齐和音轨边界校正。相同大小的字幕改动也会重新读取文件判断是否过期；Windows 上仅靠修改时间会漏掉这种改动。识别仍可能有错字，不能保证每句误差都小于 0.1 秒。Windows 实机与 CUDA 未测。

[**v1.1.29**](https://github.com/XASDSdsa/hongguo-drama-mac/releases/tag/v1.1.29) 没有安装包。Windows 构建在字幕校验处失败，Mac 构建已停止。

[**v1.1.28**](https://github.com/XASDSdsa/hongguo-drama-mac/releases/tag/v1.1.28) 只有 Mac arm64 DMG。字幕任务按剧隔离状态并共用全局并发，停止后等待进程退出。损坏或过期字幕不再标为完成，也不能进入下游。识别增加词级对齐和音轨边界校正，并检查重叠、倒序、越界。Mac 上 2 分 43 秒样本约 2.4 秒生成 62 条 SRT。Windows 安装包未发布。

[**v1.1.27**](https://github.com/XASDSdsa/hongguo-drama-mac/releases/tag/v1.1.27) 同时发布 Windows 安装包和 Mac arm64 DMG。字幕转写引擎、依赖和 tiny 模型打进应用，离线调用包内程序，不需要安装 Python，也不需要首次下载模型。Windows 包带 CUDA 12 / cuDNN 9 动态库；CI 没有实体显卡，CUDA 仍需在用户电脑验证。

[**v1.1.26**](https://github.com/XASDSdsa/hongguo-drama-mac/releases/tag/v1.1.26) 同时发布 Windows 安装包和 Mac arm64 DMG。下载管理补齐分页：上一页/下一页、输入页码跳转，视频列表每页可选 20/50/100/200，短剧列表每页可选 10/20/30/50。记录变少时自动回到仍有效的页，视频列表顶部和底部都可以翻页。

[**v1.1.25**](https://github.com/XASDSdsa/hongguo-drama-mac/releases/tag/v1.1.25) 同时发布 Windows 安装包和 Mac arm64 DMG。修复 Windows「一键去重」点击没有反应：应用打开时使用 Chromium 已经读到的显卡信息选择 NVIDIA、AMD、Intel 或 CPU 编码器，不再在点击时运行 PowerShell。Mac 仍使用 VideoToolbox。下载管理的分页与当前任务保持同步。Windows 安装包继续内置 FFmpeg 9.0.2（NVENC API 12.2）。

[**v1.1.24**](https://github.com/XASDSdsa/hongguo-drama-mac/releases/tag/v1.1.24) 修复 Windows NVENC 第一帧编码前失败：此前 Gyan FFmpeg 9.0.2 要求 API 13.1，部分用户驱动仅提供 API 12.2。现从固定源码编译 FFmpeg 9.0.2，固定使用 NVENC 12.2 头文件，保留 9.0.2 的滤镜调度修复和 NVIDIA/AMD/Intel 既定编码器方案，不自动切换编码器。安装脚本校验压缩包和两个程序的 SHA256，防止同版本旧构建混入；失败日志和任务快照显示完整原因，零帧失败不再显示 99% 进度或标记已去重。并发 1～8 路继续支持。Windows/macOS 的实际媒体、双路 1080p 和队列回归由发布工作流验证；CI 没有独立显卡，NVENC、AMF、QSV 的实机验证范围仍有限。

[**v1.1.23**](https://github.com/XASDSdsa/hongguo-drama-mac/releases/tag/v1.1.23) 在下载管理的视频列表表头增加去重并发设置，与视频处理页同步保存并即时生效。显示实际运行和等待数量，支持处理期间追加新下载的视频，防止运行或排队中的视频被重复提交，并修复旧任务快照覆盖新任务进度的问题。

[**v1.1.22**](https://github.com/XASDSdsa/hongguo-drama-mac/releases/tag/v1.1.22) 撤掉按静默时长终止去重的规则。编码、写入 MP4 索引、校验和保存按真实事件显示；只有成功退出、校验并保存后才标记已去重。进度以视频流时长估算，日志记录实际帧数、速度与媒体时间。Windows 内置 FFmpeg 从 7.1 升至固定 9.0.2，包含 [apad 滤镜源调度修复](https://ffmpeg.org/pipermail/ffmpeg-cvslog/2024-October/145933.html)，保留既定显卡编码器选择和并发设置。真实媒体回归覆盖循环 BGM、长音频、音画偏移、默认 1080p 完整滤镜及两个并行任务；CI 不具备用户的 NVIDIA、AMD、Intel 显卡，硬件编码仍需对应设备实测。

Windows 对照验证：[原 7.1 在 1.2 秒样本停留编码阶段](https://github.com/XASDSdsa/hongguo-drama-mac/actions/runs/38192507710)，手动停止诊断作业后取得日志；[9.0.2 完整回归通过](https://github.com/XASDSdsa/hongguo-drama-mac/actions/runs/38192936147/job/114629384346)。对照中的 7.1.1 能结束原挂点，但未通过偏移轨时长检查，因此发行包固定使用 9.0.2。

[**v1.1.21**](https://github.com/XASDSdsa/hongguo-drama-mac/releases/tag/v1.1.21) Windows 首次启动读取显卡名称并固定编码器：NVIDIA 使用 NVENC、AMD 使用 AMF、Intel 使用 QSV；没有可用硬件时使用 CPU/libx264。任务期间不探测、不切换、不回退，并使用速度优先 preset。

[**v1.1.20**](https://github.com/XASDSdsa/hongguo-drama-mac/releases/tag/v1.1.20) 将 Windows 去重改为固定使用 CPU/libx264，不再自动探测或切换编码器；手动选择 NVENC、AMF、QSV 时只使用所选编码器，失败直接报告。

[**v1.1.19**](https://github.com/XASDSdsa/hongguo-drama-mac/releases/tag/v1.1.19) 修复 Windows 去重在窗口关闭时的主进程崩溃，并增加硬件编码选项。该版本曾加入 180 秒无输出终止规则；它不能证明或解决原始 98% 卡住原因，现已撤除。

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

Windows 包使用 **FFmpeg 9.0.2-hongguo-nvenc12.2**，固定 nv-codec-headers n12.2.72.0，并保留 NVENC、AMF、QSV 和 CPU 编码器。该构建和完整对应源码包位于[固定依赖发行页](https://github.com/XASDSdsa/hongguo-drama-mac/releases/tag/ffmpeg-9.0.2-nvenc12.2)，准确 SHA256 位于 `build/ffmpeg/WINDOWS-BUILD.json`；构建脚本是 `scripts/build-ffmpeg-source-win.sh`。包内附带实际构建报告及依赖许可，静态链接依赖已包含，使用时无需安装 MSYS2。

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
