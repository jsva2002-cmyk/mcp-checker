import Link from 'next/link';
import Image from 'next/image';
import { GITHUB_REPO_URL } from '@/lib/constants';

export function Navbar() {
  return (
    <header className="border-b border-line">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between gap-3">
        <Link href="/" className="flex items-center gap-[10px] shrink-0">
          <Image src="/logo-icon.png" alt="" width={253} height={442} className="h-9 sm:h-11 w-auto translate-y-[1px]" priority />
          {/* Icon includes antennae above the hexagon body, so its flex-centered
              midpoint sits well above the hexagon's own visual center. Nudge the
              wordmark down to line up with the hexagon instead of the full icon
              bounding box (measured: hexagon center sits ~7.5px below the icon's
              box center at this display height). */}
          <Image src="/logo-wordmark.png" alt="Problex" width={1232} height={203} className="h-[18px] sm:h-[22px] w-auto translate-y-[6px] sm:translate-y-[7px]" priority />
        </Link>
        <div className="flex items-center gap-2 sm:gap-4 shrink-0">
          <a
            href={GITHUB_REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="hidden sm:inline-block text-xs text-muted hover:text-fg transition-colors"
          >
            GitHub
          </a>
          <Link
            href="/check"
            className="px-2.5 sm:px-3 py-1.5 bg-suggestion hover:brightness-110 active:brightness-90
                       text-canvas font-semibold text-xs rounded transition-[filter] whitespace-nowrap"
          >
            <span className="sm:hidden">Validate →</span>
            <span className="hidden sm:inline">Validate Server →</span>
          </Link>
        </div>
      </div>
    </header>
  );
}
