import type { Metadata } from "next";
import { Noto_Sans_TC, Space_Grotesk } from "next/font/google";
import "./globals.css";

const spaceGrotesk = Space_Grotesk({
  variable: "--font-space-grotesk",
  subsets: ["latin"],
  display: "swap",
});

const notoSansTc = Noto_Sans_TC({
  variable: "--font-noto-sans-tc",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Minecraft 模組跨版本清單轉換器",
  description: "協助玩家快速轉換模組清單並生成新版本 .mrpack",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-Hant">
      <body
        className={`${spaceGrotesk.variable} ${notoSansTc.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
