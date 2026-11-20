# Windows 小包更新

日常界面和业务代码修改使用 `Windows build` 的 `quick=true`（默认）。`repack_from_installer_run` 留空或填 `patch`。该流程输出可直接由现有软件「检查更新 → 下载更新 → 重启并更新」接收的小型 EXE；用户不需要解压、运行脚本或先安装另一个引导版本。

小包只携带压缩的 ASAR、更新配置和启动程序的 PE 头/资源段。电脑上的 Electron 主体、FFmpeg、模型、JRE、Office 和其他运行库保留。构建包超过 25 MiB、Electron 核心/fuses/布局变化或固定运行库源码变化时，流水线直接失败，不能自动改为全量包。运行库升级需要明确选择完整安装包流程。

当前兼容基线为已验收的 1.2.51，支持同一运行库系列的后续小版本。安装先核对版本、核心指纹和全部目标哈希；重建后的 EXE 必须与本次构建 EXE 完全一致，保留 ASAR 完整性校验。替换前备份并写事务日志，失败回滚；中途断电或终止后，重新运行同一更新包可恢复并重试。它不是全新安装程序。

固定构建基线保存在 GitHub 草稿 `windows-patch-baseline-1.2.51` 的 `changeFileName-1.2.51-patch-baseline.zip`，约22MB，构建脚本固定校验 SHA256。它不含 Electron 主体或 JRE，不上传授权服务器，也不依赖两天后过期的 Actions 临时产物。

流水线通过真实 1.2.51 ASAR 内的 electron-updater 下载和安装补丁，测试任务阻止、中文及空格路径、自动重启、授权门、错误哈希/错误核心拒绝、复制中途回滚、事务中断恢复和原有运行库/数据保留。验收证据为 `automatic-update-acceptance.json`。

管理员仍在原授权后台的软件更新页面上传同次构建的三个文件：`changeFileName-Setup-版本.exe`、`.exe.blockmap`、`release-版本.json`。小包仍用此兼容文件名，但内容是应用补丁；以 JSON 中的 `updateType: application-patch` 和实际大小识别。验证通过后发布即可，原登录及客户端更新地址不变。

已有 quick 构建产物时，可传 `quick_artifact_run=<run>`，只生成和测试小补丁；不再提取或压缩数 GB 的完整运行库。
