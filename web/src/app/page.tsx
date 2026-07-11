'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function Home() {
  const [url, setUrl] = useState('');
  const [includeAi, setIncludeAi] = useState(true);
  const router = useRouter();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim()) return;
    const params = new URLSearchParams({ url: url.trim(), ai: String(includeAi) });
    router.push(`/results?${params.toString()}`);
  };

  return (
    <main className="min-h-screen bg-slate-950 flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-lg">
        {/* Header */}
        <div className="text-center mb-10">
          <div className="inline-flex items-center justify-center w-14 h-14 bg-blue-600/20 border border-blue-500/30 rounded-2xl mb-5">
            <svg className="w-7 h-7 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M21 21l-4.35-4.35M17 11a6 6 0 11-12 0 6 6 0 0112 0z" />
            </svg>
          </div>
          <h1 className="text-3xl font-bold text-slate-100 mb-2">MCP Server Checker</h1>
          <p className="text-slate-400 text-sm leading-relaxed">
            Validate your MCP server before you ship. Protocol conformance, tool clarity, and
            agent compatibility — in one report.
          </p>
        </div>

        {/* Card */}
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-2xl">
          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label htmlFor="url" className="block text-sm font-medium text-slate-400 mb-2">
                MCP Server URL
              </label>
              <input
                id="url"
                type="url"
                value={url}
                onChange={e => setUrl(e.target.value)}
                placeholder="https://mcp.deepwiki.com/mcp"
                required
                className="w-full px-4 py-3 bg-slate-800 border border-slate-700 rounded-xl text-slate-100
                           placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-blue-500
                           focus:border-transparent transition-all font-mono text-sm"
              />
            </div>

            {/* Full validation toggle */}
            <label className="flex items-center gap-3 cursor-pointer group">
              <div className="relative flex-shrink-0">
                <input
                  type="checkbox"
                  checked={includeAi}
                  onChange={e => setIncludeAi(e.target.checked)}
                  className="sr-only peer"
                />
                <div className="w-11 h-6 bg-slate-700 peer-checked:bg-blue-600 rounded-full transition-colors" />
                <div className="absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform peer-checked:translate-x-5" />
              </div>
              <div>
                <span className="text-sm font-medium text-slate-300 group-hover:text-slate-100 transition-colors">
                  Run full validation
                </span>
                <p className="text-xs text-slate-500 mt-0.5">Includes behavior and compatibility checks</p>
              </div>
            </label>

            <button
              type="submit"
              className="w-full py-3 px-6 bg-blue-600 hover:bg-blue-500 active:bg-blue-700 text-white
                         font-semibold rounded-xl transition-colors"
            >
              Validate Server →
            </button>
          </form>

          <p className="mt-4 text-center text-xs text-slate-600">
            10 free checks per hour · No account required · Works on any public MCP server
          </p>
        </div>
      </div>
    </main>
  );
}
