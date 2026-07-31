# 汇丰 Pulse 返现记录

一款用于记录 HSBC Pulse 信用卡消费和估算奖赏钱（RC）的本地优先 PWA。

## 功能

- 记录日期、金额、币种、地区、类别、支付方式和备注。
- 自动计算基础 0.4%、迎新奖励、最红自主奖赏「赏世界」、Pulse 额外 2% 和内地餐饮额外 3%。
- 显示 8,000 迎新门槛、80,000 Pulse 额外上限、100,000 赏世界上限，以及 2026-07-01 至 2026-12-31 内地餐饮每月 1,200 内地签账门槛、3% 月 80/总 480 RC 封顶。
- 支持上传截图用本地 OCR 预填日期、金额、币种、地区、类别、支付方式和备注，确认后再保存。
- 数据保存在当前设备浏览器的 localStorage，支持复制 JSON 备份。
- 支持 iPhone Safari 添加到主屏幕，并注册离线缓存。

## 手机使用

部署到 GitHub Pages 后，用 iPhone Safari 打开页面，点分享按钮，选择“添加到主屏幕”。消费记录会保存在当前手机浏览器本地。

## GitHub Pages 设置

仓库进入 Settings → Pages，选择：

- Source: Deploy from a branch
- Branch: `main`
- Folder: `/docs`

保存后页面地址通常是：

`https://kejin1106.github.io/hsbc-pulse-rc-tracker/`

## 本地运行

```bash
npm install
npm run dev
```

## 验证

```bash
npm run build
npm test
```

HKD/RMB 在工具中按 1:1 记录；最终到账以汇丰账单和活动条款为准。
