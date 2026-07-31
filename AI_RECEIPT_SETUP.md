# AI 截图识别后端部署

这个后端只做一件事：接收网页上传的截图，调用 OpenAI 视觉模型，返回结构化消费记录。OpenAI API Key 不会放在 GitHub Pages 前端里。

## 推荐方案

Cloudflare Workers 比较适合个人工具：部署简单，有免费额度，付费版最低门槛也低。OpenAI 模型名放在 `worker/wrangler.toml` 的 `OPENAI_MODEL`，后续可以替换。

## 部署步骤

```bash
cd worker
npx wrangler login
npx wrangler secret put OPENAI_API_KEY
npx wrangler deploy
```

部署完成后会得到类似：

```text
https://hsbc-pulse-receipt-ai.<你的账号>.workers.dev
```

把这个 URL 填到网页里的「AI 接口 URL」，然后点「AI 识别截图」即可。

## 注意

- 截图会发送给 OpenAI API 做识别；不要上传未打码的敏感截图，或至少先裁剪掉姓名、完整卡号、电话、地址。
- AI 只会预填表单，不会自动保存。保存前请确认金额、日期、类别和支付方式。
- 如果模型不可用，可以把 `OPENAI_MODEL` 改成你账号支持的视觉模型。
