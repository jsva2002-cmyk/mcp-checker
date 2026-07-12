import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'MCP Server Checker',
  description: 'Validate MCP server protocol conformance and agent compatibility',
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
