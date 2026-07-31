import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "汇丰 Pulse 返现记录",
  description: "记录 HSBC Pulse 信用卡消费并自动计算迎新、赏世界、Pulse 额外和内地餐饮返现。",
  applicationName: "Pulse RC",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: "/favicon.svg",
    apple: "/app-icon.svg",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  themeColor: "#f4f7f5",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-Hans">
      <body>{children}</body>
    </html>
  );
}
