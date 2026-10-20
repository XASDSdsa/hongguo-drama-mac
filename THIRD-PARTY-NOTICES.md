# 第三方组件许可说明

本软件（AI短剧助手）使用了以下第三方组件。各组件的版权归其各自作者所有，
本软件对这些组件的使用均遵循其原始许可证。

---

## 运行时依赖

| 组件 | 版本 | 许可证 | 项目地址 |
|---|---|---|---|
| Electron | 44.6.0 | MIT | https://github.com/electron/electron |
| React | 18.3.1 | MIT | https://github.com/facebook/react |
| React DOM | 18.3.1 | MIT | https://github.com/facebook/react |
| axios | ^1.13.2 | MIT | https://github.com/axios/axios |

Electron 打包产物中已包含 Chromium 与 Node.js 的许可声明：

- `LICENSE.electron.txt`
- `LICENSES.chromium.html`

---

## 内置可执行程序

### Windows FFmpeg（GPLv3-or-later）

| 项 | 说明 |
|---|---|
| 文件 | `resources/bin/ffmpeg.exe`、`resources/bin/ffprobe.exe` |
| 版本 | FFmpeg 9.0.2-hongguo-nvenc12.2 |
| 来源 | 本仓库 `scripts/build-ffmpeg-source-win.sh`，固定源码构建 |
| 构建参数 | 含 `--enable-gpl --enable-version3 --enable-libx264 --enable-libvpl --enable-nvenc --enable-amf` |
| **许可证** | **GNU General Public License v3.0 or later** |
| 完整对应源码 | https://github.com/XASDSdsa/hongguo-drama-mac/releases/tag/ffmpeg-9.0.2-nvenc12.2 |

用途：视频去重、分片拼接及「兼容模式」格式转码
（解决部分电脑无法硬件解码 HEVC 导致的「黑屏有声」）。

随软件分发的许可证全文位于 `resources/bin/`：

- `COPYING.GPLv3` —— GPLv3 全文（本构建适用的主许可证）
- `COPYING.GPLv2` —— GPLv2 全文
- `COPYING.LGPLv2.1` —— LGPLv2.1 全文
- `LICENSE.md` —— FFmpeg 官方许可证说明
- `FFMPEG-NOTICE.txt` —— 本项目的补充说明与源码获取方式

FFmpeg 是独立的第三方程序，本软件仅通过命令行调用其公开接口，未修改其源码。

静态依赖包括 x264（GPLv2-or-later）、libvpl 2.17.0（MIT）、zlib 1.3.2（zlib 许可）；
构建时使用 nv-codec-headers n12.2.72.0（MIT）和 AMF 1.5.2 头文件（MIT）。
各依赖许可证、NVENC 头文件许可、准确版本与构建配置随 Windows 程序附带。
完整对应源码包同时包含这些依赖和准确构建脚本。libvpl 仅修正旧 MSVC shim 的条件，准确补丁也随源码包附带。未启用 nonfree，PE 导入仅包含 Windows 系统库；硬件编码使用已安装的相应显卡驱动。

---

### Mac FFmpeg / FFprobe（GPLv3-or-later）

Apple Silicon 包内置从未修改源码编译的 FFmpeg 9.0.2 与 x264 b35605ace3ddf7c1a5d67a2eb553f034aef41d55，文件位于 `Contents/Resources/bin/`。
x264 是唯一非系统静态依赖（GPLv2-or-later），整体构建为 GPLv3-or-later；完整对应源码与准确构建脚本随 Release 提供。
准确来源、版本、构建配置及对应源码要求见 `build/ffmpeg/MACOS-NOTICE.txt`、
`MACOS-VERSIONS.txt` 和 `MACOS-LICENSE.txt`。

## 开发依赖

### 内置 faster-whisper 字幕运行时

安装包的 `faster-whisper/` 目录包含独立运行的 Python 字幕程序、tiny 模型及其依赖。
用户不需要安装 Python、pip 或下载模型。准确构建版本见该目录的 `licenses/versions.json`，
各组件的许可文本随包放入 `licenses/`。源码构建入口为 `scripts/setup-faster-whisper.cjs`。

主要组件包括 Python（PSF）、faster-whisper / Whisper tiny（MIT）、CTranslate2（MIT）、
ONNX Runtime（MIT）、PyAV（BSD，所含 FFmpeg 库另有 LGPL/GPL 许可）和 PyInstaller
引导程序（GPL，含允许分发生成程序的例外）。Windows 包额外包含 NVIDIA CUDA 12
cuBLAS、cuDNN 9 及 CUDA runtime 的可再分发动态库和 Microsoft Visual C++ 运行时；
对应许可文件包含在 `licenses/` 中。显卡驱动属于系统环境，不随本应用修改或安装。


构建期使用以下工具（不随软件分发）：

| 组件 | 许可证 |
|---|---|
| Vite | MIT |
| electron-builder | MIT |
| @vitejs/plugin-react | MIT |
| concurrently | MIT |
| wait-on | MIT |

---

## 本软件自身

本软件基于上游项目二次开发，整体以 **GNU General Public License v3.0** 发布，
详见仓库根目录的 `LICENSE` 与 `NOTICE`。

## App 片源签名及 Spade 算法

改编自 woshishiq1/drpys，经 N3urda/hongguoTV 的 vendor 源码核对，GPL-3.0。
完整来源与修改说明见 `src/native/licenses/NOTICE.txt`，许可见同目录 `LICENSE.drpys.txt`。

## 西饭接口参考

独立编写适配器；接口路径核对参考 [Hululu007/drpy-node](https://github.com/Hululu007/drpy-node/tree/295f2b7047e14122d542a7736cb931e81abcf85c)（GPL-3.0）。
未复制其中的会话标识或解锁流程。公开接口可访问不代表作品获得再分发授权；安装包不包含剧集媒体。

## 本地视频结构化拆解

- TransNet V2：MIT，Tomáš Souček 等。PyTorch 网络文件固定于提交 85cef72af9a916bdfd7cc94a670c9cdfbf12d1ed；许可证随源码存放于 src/native/video-structure/vendor/TRANSNET-LICENSE.txt。模型由该提交的官方权重转换，构建记录包含哈希。
- sherpa-onnx 1.13.8：Apache-2.0，原生音源分离程序和离线识别绑定，许可证随运行时收集。
- 分离模型采用 k2-fsa/sherpa-onnx 官方 source-separation-models 发布的适配版 UVR-MDX-NET-Inst_HQ_3.onnx，上游模型来源 TRvlvr/model_repo。
- Paraformer 和 Silero VAD 采用 sherpa-onnx 官方 asr-models 发布文件，构建脚本固定 SHA256。模型来源和版本随 runtime.json 保存；模型使用条件独立于推理程序许可证。
- 中文标点恢复采用 sherpa-onnx 官方发布的 CT-Transformer 2024-04-12 int8 转换模型；上游 [ModelScope iic 模型卡](https://modelscope.cn/models/iic/punc_ct-transformer_zh-cn-common-vocab272727-pytorch/) 标注 Apache-2.0。安装包仅在本机运行该模型，构建脚本校验模型 SHA256；标点只是句界候选，不能保证语义准确。
- PyTorch 2.5.1、NumPy 1.26.4 许可证随内置运行时收集；用户端不会执行 pip 或在线安装模型。

## 海报标题字体

AI 发布素材生成海报时，标题由程序用下列字体渲染（均为 SIL Open Font License 1.1，允许商用与随软件分发；不单独出售字体本身）。
字体文件取自 [Fontsource](https://fontsource.org/) 的 npm 包（构建时由 `npm run setup:title-fonts` 拷贝），各字体的许可证文本随安装包放在 `title-fonts/<字体名>/LICENSE.txt`。

| 字体 | 来源 |
| --- | --- |
| Noto Sans SC（思源黑体） | Google / Adobe，@fontsource/noto-sans-sc |
| Noto Serif SC（思源宋体） | Google / Adobe，@fontsource/noto-serif-sc |
| ZCOOL QingKe HuangYou（站酷庆科黄油体） | 站酷，@fontsource/zcool-qingke-huangyou |
| ZCOOL KuaiLe（站酷快乐体） | 站酷，@fontsource/zcool-kuaile |
| Ma Shan Zheng（马善政毛笔楷书） | Ma Shan Zheng Project Authors，@fontsource/ma-shan-zheng |
