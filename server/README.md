# changeFileName 软件更新

管理员入口：https://license.91.200.243.95.sslip.io/manage

沿用现有授权后台的登录。登录后可进入「授权管理」或「软件更新」，更新服务不接触授权数据库。

## 发布

1. 为每次发布递增 `package.json` 和 lockfile 中的版本，构建同一批 Windows NSIS 安装程序。
2. 构建运行 `node scripts/make-update-release.cjs <输出目录>`，检查安装包 SHA512 与块映射，产生 `release-版本号.json`。
3. 在「软件更新」选择三个文件：`changeFileName-Setup-版本号.exe`、对应 `.exe.blockmap`、`release-版本号.json`。
4. 上传完成后填写更新说明并点击发布。服务器检查版本、文件长度和哈希，所有文件就位后原子切换当前发布版本。已发布版本不能覆盖。
5. 用户启动软件会检查新版本，也可以在左下角点击「检查更新」。下载完成后点「重启并更新」。有任务时禁止安装，正常退出不会擅自安装。

撤回会停止提示该版本，并阻止已下载客户端继续安装。已经安装的客户端不会降级；修复请发布更高版本。旧版本文件保留以支持差量下载。首次没有更新缓存时可能完整下载。

## 部署与数据

现有 `/opt/short-drama-license/owner-gateway.py` 引入同目录 `updates.py`，并挂载 `updates.html`、`updates-ui.js` 和可写的 `updates-data:/data/updates`。容器仍以 UID 65534 运行。

Caddy 将 `/manage`、`/admin/updates`、`/admin/updates/*`、`/updates/windows/*` 转发到同一登录网关，保留原来的私有网关头。更新文件仅公开 GET/HEAD；后台写操作要求会话、同源和 CSRF token。下载支持单段 Range，`latest.yml` 不缓存，发布文件不可覆盖。

`updates-data/current.json` 是当前发布指针，`releases/版本号/` 是发布文件，`uploads/` 是尚未发布的文件。持久化和备份整个目录。不要把登录密钥、管理员密码或用户模板写入源码或发布包。

1.2.51 首次启用更新器：现有用户需最后手动更新一次。快速更新包含 `resources/app-update.yml`；以后 NSIS 更新会保留原安装路径和用户数据。此发行线支持 Windows；Mac 需要正式签名后另行接入。

验证：`node scripts/check-app-updates.cjs`、`python3 scripts/check-update-server.py`、`node src/components/check-ui-state.cjs`。Windows 完整构建会提供 windows-in-app-update-release，包含后台上传所需的三份文件。仅在运行库和 Electron 版本未变时可复用已验收的 1.2.49 完整安装包运行库，并运行实际打包更新器的下载、忙碌保护及静默安装验收。
