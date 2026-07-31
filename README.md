# 汇丰 Pulse 返现记录

一款用于记录 HSBC Pulse 信用卡消费和估算奖赏钱（RC）的本地优先 PWA。

## 手机使用

部署到 GitHub Pages 后，用 iPhone Safari 打开页面，点分享按钮，选择“添加到主屏幕”。消费记录会保存在当前手机浏览器本地。

## GitHub Pages 设置

仓库进入 Settings → Pages，选择：

- Source: Deploy from a branch
- Branch: `main`
- Folder: `/docs`

保存后页面地址通常是：

`https://kejin1106.github.io/hsbc-pulse-rc-tracker/`

## 返现规则

- 基础返现：0.4%。
- 迎新：开卡后 60 天内刷满 8,000，估算 800 RC + 1,000 RC。
- 迎新单笔：达标后，60 天内每笔超过 50 的消费额外 10 RC，最多 28 次。
- 最红自主奖赏「赏世界」：登记后，中国内地和澳门消费额外 2%，上限 100,000 消费。
- Pulse 额外奖赏：Apple Pay 或云闪付额外 2%，上限 80,000 消费。
- 中国内地餐饮：每月合资格签账满 1,200 后，内地餐饮额外 3%，每月最高 80 RC，推广期最高 480 RC。

HKD/RMB 在工具中按 1:1 记录；最终到账以汇丰账单和活动条款为准。
