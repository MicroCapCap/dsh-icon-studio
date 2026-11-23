# DSH 图标工坊 — 细节

## 为什么有四个位置

DeepSeek Harness 的图标来自四个互不相干的地方，必须分别更换：

1. **`resources/tray.ico`** —— 托盘图标。`lib/main.js` 用
   `nativeImage.createFromPath(join(process.resourcesPath, 'tray.ico'))` 读取，
   再交给 `Tray`；只在启动时读一次。
2. **`resources/icon.png`** —— 关于面板图标，传给
   `app.setAboutPanelOptions({ iconPath })`。
3. **快捷方式的 `IconLocation`** —— 资源管理器里桌面和开始菜单显示的那个图标。
   应用没有设置 AppUserModelID，窗口按钮的身份通常由启动它的快捷方式推导。
4. **`DeepSeek Harness.exe` 里的图标资源** —— 窗口图标、任务栏按钮、Alt-Tab、
   资源管理器里的文件图标。应用没有给 `BrowserWindow` 传 `icon`，Electron 就回退
   到可执行文件自带的 `RT_GROUP_ICON`。

第 1 项和第 4 项来源独立，所以换托盘图标永远不会自动换掉任务栏图标，插件因此
把四处一起改。

## 可执行文件如何打补丁

`scripts/iconstudio.py` 调用 `kernel32` 的 `BeginUpdateResourceW` /
`UpdateResourceW` / `EndUpdateResourceW`：新的各尺寸帧写成新的 `RT_ICON`
资源，原有的 `RT_GROUP_ICON` 改写成指向它们，由 Windows 重写 `.rsrc` 段。
整个过程不手工改字节，PE 布局保持自洽——只有资源段、重定位目录指针和可选的
校验和会变化。

替换用重命名完成：Windows 允许重命名运行中进程的映像，但不允许覆盖，所以在用的
`DeepSeek Harness.exe` 先改名成 `DeepSeek Harness.exe.previous`，再把打好补丁的
文件复制进去并比对哈希；复制失败就把改名回滚。残留文件被运行中的进程锁住，要等
进程退出才能删，所以插件每次启动都会重试删除（`cmd_cleanup`），并同时匹配
`.previous` 与 `.pre-` 命名的文件，旧脚本留下的残留也会一起清掉。

同一个图标重复应用不会让文件变大：状态里记录了本插件打出的补丁哈希，只要在用的
可执行文件仍是它，下一次就从 `originals\DeepSeek Harness.exe` 重新打补丁，而不是
在已打补丁的文件上再叠一层图标组，结果字节完全一致。

## 图像处理流程

1. 解码 PNG（颜色类型 0、2、3、4、6；位深 8，另支持亚字节调色板）。
2. 透明度：保留已有透明通道；否则按
   `alpha = clip((245 - min(r, g, b)) / 12, 0, 1)` 去掉白底——用最暗通道驱动
   alpha 斜坡，抗锯齿边缘保持柔和，内部白色镂空也被打穿。
3. 按 alpha 包围盒裁切，居中放到带 4% 边距的正方形画布。
4. 预乘 alpha 后按面积平均缩放到 16/24/32/48/64/128/256/512，再解预乘；预乘
   可以避免边缘出现暗边。
5. 16–128 像素输出 32 位 DIB 帧，256 像素输出 PNG 帧，这正是资源管理器对大图标
   的期望格式。

## 状态文件

`%LOCALAPPDATA%\DSH-IconStudio\state.json` 记录已应用的图标、可执行文件哈希和
原始取值。`originals\` 是备份，`icons\<slug>\` 是每次生成的图标集（`icon.ico`、
`icon.png`、`source.png`、`preview.png` 预览拼图），`staging\` 是打补丁用的临时
目录。slug 由文件名主干加图片哈希前 8 位组成；文件名本身没有信息时（附件仓库按
哈希命名文件）回退成 `icon-<hash>`，同一张图每次都会落进同一个目录。

`originals\` 可以预先塞入更早的备份：首次应用前把官方 `tray.ico`、`icon.png` 和
可执行文件放进该目录，`dsh_icon_restore` 就会还原官方图标，而不是首次运行时的
现场状态。插件本身只记录它看到的东西，预先放入备份是保证可干净回滚的办法。

引擎命令（stdin 传 JSON，参数 `--json-in`）：`status`、`build`（只生成资源，不动
系统）、`ingest`（把上传的 PNG 存进 `uploads\`）、`preview`（解析已生成图标的
预览图）、`apply`、`restore`、`cleanup`、`selftest`。

`build` 与 `apply` 都接受 `image`（PNG 路径）或 `slug`（之前生成过的图标，经
`icons\<slug>\source.png` 解析），所以设置页预览完不必再上传一次就能直接应用。

## 设置页

`client.js` 注册一个 `settings.section`（`id: dsh-icon-studio`，标签 `DSH icons`，
order 331）并渲染面板。它自己不碰文件：用 `FileReader` 在本地读出 PNG，把 base64
POST 到 `/api/dsh-icon-studio/build`，显示返回的预览图，只有按下 Apply 才调用
`/api/dsh-icon-studio/apply`。`tests\` 里的 `routes.mjs` 和 `client.mjs` 不需要浏览器
就能覆盖两侧：前者用假的 request/response 驱动路由，后者用桩 React 跑客户端工厂，
断言设置区块注册成功、渲染一遍不报错。

路由注册在 `ctx.webServer` 上，并有三重围栏：socket 必须是 loopback、
`sec-fetch-site` 不能是 `cross-site`、`Origin` 必须与 `Host` 一致。上传大小上限
32 MiB，只接受 PNG 签名；`uploads\` 只保留最近十个文件。

用 `DSH_ICON_STUDIO_HOME` 可以整体改位置，`DSH_ICON_STUDIO_PYTHON` 指定解释器，
`DSH_ICON_STUDIO_INSTALL` 指定安装目录（不给就先尝试可执行文件所在目录，再依次
尝试常见安装位置）。
