# Korea Live Translate

iPhone 优先的个人韩语会议实时翻译 PWA。浏览器把麦克风音频流直接发送至 Azure Speech Translation，将 `ko-KR` 实时转为 `zh-Hans`；应用本身不录音、不保存音频，也不生成说话人标签或摘要。

## 已实现范围

- Azure Speech SDK 连续识别：灰色临时字幕可覆盖，最终字幕冻结。
- 状态机与断档记录：权限请求、连接、收听、重连、停止和错误；重连退避为 1、2、4、8、15 秒。
- 页面隐藏、离线、Speech 会话取消或令牌刷新失败时停止当前连接并留下明确缺失区间。
- 仅将最终字幕和缺失标记保存到 IndexedDB；刷新后可恢复或删除本场草稿。
- 结束后导出带 UTF-8 BOM 的双语 Markdown；只有在下载后再次确认，才能清除本地草稿。
- 个人口令登录、12 小时签名会话 Cookie，以及仅在服务端使用的 Azure Speech 密钥。
- Service Worker 仅缓存同源应用外壳，明确排除 `/api/*`；字幕、登录、令牌和 Speech 响应不会进入 Cache Storage。

## 架构与数据边界

```text
iPhone Safari / PWA
  ├─ 麦克风音频 ───────────────→ Azure Speech Translation
  ├─ POST /api/speech/token ───→ Azure Static Web Apps managed Function
  │                               └─ Azure Speech subscription key（仅服务端）
  └─ IndexedDB
      └─ 最终字幕 + 缺失区间（不含音频、临时字幕和长期历史）
```

音频会按 Azure Speech SDK 的实时传输机制发送到云端。使用前必须告知所有参会者并取得同意。本项目不承诺逐字准确，也不能替代正式会议纪要、法律记录或可引用的学术材料。

## 本地开发

要求 Node.js 22（仓库含 `.nvmrc`）。

```powershell
npm install
npm --prefix api install
Copy-Item api/local.settings.example.json api/local.settings.json
npm run auth:hash
```

将生成的 scrypt 字符串写入 `api/local.settings.json` 的 `APP_PASSWORD_SCRYPT_HASH`。再生成至少 32 字符的随机会话密钥：

```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

同时填入自己的 Azure Speech F0 密钥。`api/local.settings.json` 已被 Git 忽略，不应提交。完成配置后：

```powershell
npm run dev
```

前端为 `http://localhost:5173`，本地 API 为 `http://127.0.0.1:7071`。本地配置中的 `APP_COOKIE_SECURE` 应为 `false`；生产环境必须为 `true`。

## Azure 与 GitHub 部署

1. 在 Azure 创建 Speech F0 资源。本项目当前资源位于 `eastasia`；客户端始终使用令牌接口返回的实际区域。
2. 创建 Azure Static Web Apps Free 资源，连接本仓库的 `main` 分支；应用位置 `/`、API 位置 `api`、输出位置 `dist`。
3. 在 Static Web App 的应用设置中配置：

   - `AZURE_SPEECH_KEY`
   - `AZURE_SPEECH_REGION=eastasia`
   - `APP_PASSWORD_SCRYPT_HASH`
   - `SESSION_SIGNING_SECRET`
   - `APP_ALLOWED_ORIGINS=https://<你的-static-web-app-域名>`
   - `APP_COOKIE_SECURE=true`

4. Azure 创建流程会自动配置与资源绑定的 GitHub Actions secret。仓库提供的工作流会在每次推送 `main` 时先执行 lint、前端/API 测试和生产构建，再部署到生产环境。

任何密钥或口令都不得写入源代码、GitHub 普通变量、前端 `.env` 或截图。若 Static Web Apps 的最终域名发生变化，必须同步更新 `APP_ALLOWED_ORIGINS`。

## 验证

自动验证：

```powershell
npm run check
```

真机验收仍需在真实 Azure 资源和取得同意的韩语样本上完成：

- iPhone Safari 前台连续运行 30 分钟，并确认至少两次令牌刷新。
- 普通 Safari 标签页和主屏幕 PWA 分别检查；若 PWA 麦克风稳定性不足，正式使用固定为前台 Safari。
- 记录临时中文字幕延迟的中位数与 P95，目标分别为不超过 4 秒和 8 秒；这是项目验收目标，不是 Azure SLA。
- 强制断网 15 秒，确认恢复后存在明确断档标记且最终字幕不重复。
- 刷新后恢复草稿；导出并二次确认清除后，IndexedDB 不再保留本场内容。
- 对真实会议样本只记录主观可理解性和明显异常。在没有韩中双语人工真值时，不报告“准确率”。

## 关键限制

- 适合 2–6 人、单场少于 30 分钟、iPhone 位于桌面中央且页面保持前台的会议。
- 不区分重叠说话人；重叠发言、远距离和噪声会降低识别与翻译质量。
- F0 配额耗尽或 Azure 拒绝服务时会停止并提示，不会自动升级或切换供应商。
- 浏览器/PWA 无法保证锁屏后持续采集；应用会把后台时间标为可能缺失，而不会假装记录完整。
