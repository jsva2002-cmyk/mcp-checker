import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'Problex',
  description: 'Validate your MCP server before you ship — protocol conformance, tool clarity, and agent compatibility, in one report.',
  icons: {
    // favicon.ico first so browsers that ignore <link> tags (or request
    // /favicon.ico directly) still get the branded icon instead of the
    // default globe. The white mark is on a solid #0d1117 background baked
    // into each file, so it stays visible on light-themed browser chrome too.
    icon: [
      { url: '/favicon.ico', sizes: 'any' },
      { url: '/icon-16.png', sizes: '16x16', type: 'image/png' },
      { url: '/icon-32.png', sizes: '32x32', type: 'image/png' },
      { url: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: [{ url: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="scroll-smooth">
      <body className={`${inter.className} bg-canvas text-fg min-h-screen`}>
        {children}
      </body>
    </html>
  );
}
