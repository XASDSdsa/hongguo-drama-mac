# 内置完整字幕引擎

安装包自带独立 `hongguo-transcribe` 程序、Python 运行时、faster-whisper、VAD 与 tiny 模型。
应用只调用包内程序，离线读取包内模型；最终用户不需要 Python、pip、FFmpeg 环境或首次下载模型。
Windows 包同时带 CUDA 12 / cuDNN 9 动态库以及 Visual C++ 运行时；使用 CUDA 仍需显卡本身和系统驱动支持。

## 在构建机准备资源

在目标平台本机或对应 CI 上构建（macOS ARM64 / Windows x64），需要 Node.js 和 Python 3.12：

```sh
npm run setup:transcription
npm run check:transcription-bundle
node scripts/check-bundled-transcription.cjs
```

脚本在项目 `.cache/faster-whisper/` 建立独立构建虚拟环境，不修改系统 Python 包。
依赖版本固定于 `scripts/faster-whisper-requirements.txt`，模型固定在 `build-faster-whisper.py` 的 revision。
模型在构建时获取并校验，构建结果保存在 `build/faster-whisper/<platform>-<arch>/`，不提交生成的二进制和模型。
可用 `FASTER_WHISPER_BUILD_PYTHON` 指定构建解释器；macOS 解释器和依赖必须兼容 macOS 13，
构建脚本检查 ARM64 Mach-O 的最低系统版本，拒绝把当前 Homebrew 的高版本系统依赖混入发行包。

Electron 的 `beforePack` 检查阻止缺少运行时、模型、Windows 必需 DLL 或离线自检结果的包继续发布。
Windows 和 Mac release workflow 都执行资源准备以及打包后的检查，不需要手工复制资源。

## 验证边界

`check-bundled-transcription.cjs` 把引擎复制到含中文和空格的临时目录，清空 PATH 与模型缓存，
使用无效 Python 配置，实际加载 VAD 和 tiny 模型推理。可追加第二个参数传入语音/视频，验证完整 SRT：

```sh
node scripts/check-bundled-transcription.cjs "dist/mac-arm64/红果短剧.app/Contents/Resources" sample.wav
node scripts/check-bundled-transcription.cjs dist/win-unpacked/resources sample.wav
```

CI 的 CPU 检查无法代替 Windows NVIDIA 显卡上的 CUDA 实测。任务开始时选择处理设备，任务期间不更换设备。
