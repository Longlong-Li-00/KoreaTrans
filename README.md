# Korea Live Translate

iPhone 优先的受控小规模韩语会议实时翻译 PWA。浏览器把麦克风音频流直接发送至 Azure Speech Translation，将 `ko-KR` 实时转为 `zh-Hans`；应用本身不录音、不保存音频，也不生成说话人标签或摘要。

## 已实现范围

- Azure Speech SDK 连续识别：灰色临时字幕可覆盖，最终字幕冻结。
- 状态机与断档记录：权限请求、连接、收听、主动暂停、重连、停止和错误；重连退避为 1、2、4、8、15 秒。
- 页面隐藏、离线、Speech 会话取消或令牌刷新失败时停止当前连接并留下明确缺失区间。
- 主动暂停会停止麦克风、Speech 连接和用量计时；继续后仍写入同一场会议，并保留暂停区间。
- 仅将最终字幕、缺失标记和主动暂停区间保存到 IndexedDB；多份本机草稿可分别恢复或删除，不阻止开始新会议。
- 结束后导出带 UTF-8 BOM 的双语 Markdown；只有在下载后再次确认，才能清除本地草稿。
- 所有者与独立测试账号登录、12 小时签名会话 Cookie，以及仅在服务端使用的 Azure Speech 密钥。
- 以 15 秒心跳汇总真正处于 `listening` 状态的时间，在网页显示 F0 每月 5 小时的“应用估算”剩余额度。
- 测试者可提交评分、问题类别和意见；所有者可导出 CSV。反馈只附带不含字幕的运行统计。
- 界面显示低对比度 `longlong · beta` 制作者标识。
- Service Worker 仅缓存同源应用外壳，明确排除 `/api/*`；字幕、登录、令牌和 Speech 响应不会进入 Cache Storage。

## 架构与数据边界

```text
iPhone Safari / PWA
  ├─ 麦克风音频 ───────────────→ Azure Speech Translation
  ├─ POST /api/speech/token ───→ Azure Static Web Apps managed Function
  │                               └─ Azure Speech subscription key（仅服务端）
  ├─ 用量心跳 + 测试反馈 ──────→ Azure Table Storage
  │                               └─ 用户 ID、秒数、评分和无字幕诊断
  └─ IndexedDB
      └─ 分会议草稿：最终字幕 + 缺失/主动暂停区间（不含音频和临时字幕）
```

音频会按 Azure Speech SDK 的实时传输机制发送到云端。使用前必须告知所有参会者并取得同意。本项目不承诺逐字准确，也不能替代正式会议纪要、法律记录或可引用的学术材料。网页额度是应用依据成功心跳做出的近实时估算，不等同于 Azure 账单；Azure Portal 的 `Audio Seconds Translated` 指标是最终依据。

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
   - `AZURE_SPEECH_MONTHLY_LIMIT_SECONDS=18000`
   - `APP_PASSWORD_SCRYPT_HASH`
   - `APP_TEST_USERS_JSON`（见下文，JSON 对象必须作为单行应用设置）
   - `SESSION_SIGNING_SECRET`
   - `APP_ALLOWED_ORIGINS=https://<你的-static-web-app-域名>`
   - `APP_COOKIE_SECURE=true`
   - `AZURE_STORAGE_CONNECTION_STRING`
   - `AZURE_USAGE_TABLE_NAME=KoreaTransUsage`
   - `AZURE_FEEDBACK_TABLE_NAME=KoreaTransFeedback`

4. Azure 创建流程会自动配置与资源绑定的 GitHub Actions secret。仓库提供的工作流会在每次推送 `main` 时先执行 lint、前端/API 测试和生产构建，再部署到生产环境。

任何密钥或口令都不得写入源代码、GitHub 普通变量、前端 `.env` 或截图。若 Static Web Apps 的最终域名发生变化，必须同步更新 `APP_ALLOWED_ORIGINS`。

## 受控测试账号

`APP_PASSWORD_SCRYPT_HASH` 继续对应所有者账号 `longlong`，保证旧部署可平滑升级。生成五个相互独立的测试账号：

```powershell
npm run auth:test-users -- 5
```

命令会生成两个被 Git 忽略的本地文件：

- `private/tester-credentials.txt`：分别私下发送给测试者的账号和随机口令。
- `private/app-test-users.json`：复制为 Static Web App 的 `APP_TEST_USERS_JSON` 应用设置。

删除或禁用单个测试账号后，该账号已签发的 Cookie 最长仍可能在 12 小时内有效；若需要立即全部失效，应同时轮换 `SESSION_SIGNING_SECRET`。不要在群聊中共享全部账号文件。

## 额度与反馈存储

为 Static Web App 配置一个专用的 Standard LRS Storage Account 连接字符串。API 会按需创建 `KoreaTransUsage` 与 `KoreaTransFeedback` 两个 Table：

- 用量表只保存用户 ID、会议随机 ID、心跳 ID、秒数和时间，不保存字幕或音频。
- 反馈表保存用户填写的意见及版本、状态、时长、最终字幕条数和断档数。
- 同一心跳 ID 重试时按 Table row key 去重。
- 只有 `owner` 会话可以通过网页导出全部反馈。

当前实现面向约 5 名可信测试者，不把应用估算作为计费或配额强制停止依据。网络中断导致心跳丢失时，网页估算会略低于 Azure 实际用量。
上线前已经产生的 Speech 用量不会被回填，因此网页会明确标注“仅统计此功能上线后的用量”；Azure Portal 的 `AudioSecondsTranslated` 指标仍是最终依据。

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
- 收听中主动暂停 1–2 分钟，确认麦克风与用量计时停止；继续后字幕仍进入同一场记录。
- 保留上一场未导出的草稿并开始新会议，确认两场记录可独立恢复、导出和删除。
- 刷新后恢复草稿；导出并二次确认清除后，IndexedDB 不再保留对应会议内容。
- 对真实会议样本只记录主观可理解性和明显异常。在没有韩中双语人工真值时，不报告“准确率”。

## 关键限制

- 适合 2–6 人、单场少于 30 分钟、iPhone 位于桌面中央且页面保持前台的会议。
- 不区分重叠说话人；重叠发言、远距离和噪声会降低识别与翻译质量。
- F0 配额耗尽或 Azure 拒绝服务时会停止并提示，不会自动升级或切换供应商。
- 浏览器/PWA 无法保证锁屏后持续采集；应用会把后台时间标为可能缺失，而不会假装记录完整。
