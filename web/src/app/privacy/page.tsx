import type { Metadata } from 'next';
import { Navbar } from '@/components/Navbar';
import { Footer } from '@/components/Footer';
import { GITHUB_ISSUES_URL } from '@/lib/constants';

export const metadata: Metadata = {
  title: 'Privacy Policy — Problex',
};

export default function PrivacyPage() {
  return (
    <main className="min-h-screen bg-canvas flex flex-col">
      <Navbar />

      <article className="flex-1 max-w-[700px] mx-auto px-6 py-16 w-full">
        <h1 className="text-2xl font-bold text-fg tracking-tight">Privacy Policy</h1>
        <p className="mt-1.5 text-xs text-muted">Last updated: July 2026</p>

        <p className="mt-6 text-sm text-fg/85 leading-relaxed">
          Problex (&ldquo;we,&rdquo; &ldquo;us&rdquo;) provides a free tool to validate MCP (Model Context
          Protocol) servers. This page explains what data we collect and how it&rsquo;s used.
        </p>

        <h2 className="mt-10 text-lg font-semibold text-fg">What we collect</h2>
        <p className="mt-3 text-sm text-fg/85 leading-relaxed">
          <span className="text-fg font-medium">Server URLs you submit.</span> When you paste a URL into
          Problex, we send it to Anthropic&rsquo;s Claude API to run automated validation checks (schema
          validation, tool clarity analysis, and simulated agent behavior testing). We do not store the
          content of your scans permanently — reports are generated on demand and not saved to an account,
          because Problex does not currently offer accounts.
        </p>
        <p className="mt-4 text-sm text-fg/85 leading-relaxed">
          <span className="text-fg font-medium">IP address.</span> We temporarily log your IP address to
          enforce our rate limit (10 checks per hour). This is stored in Upstash Redis and used only for
          rate limiting.
        </p>

        <h2 className="mt-10 text-lg font-semibold text-fg">What we don&rsquo;t do</h2>
        <ul className="mt-3 space-y-2 text-sm text-fg/85 leading-relaxed list-disc list-outside pl-5">
          <li>We don&rsquo;t require an account, email, or any personal information to use Problex.</li>
          <li>We don&rsquo;t sell or share your data with third parties for marketing or advertising.</li>
        </ul>

        <h2 className="mt-10 text-lg font-semibold text-fg">Analytics</h2>
        <p className="mt-3 text-sm text-fg/85 leading-relaxed">
          We use PostHog, a product analytics service, to understand how Problex is used. This helps us see
          which features are useful and where the product needs improvement.
        </p>
        <p className="mt-4 text-sm text-fg/85 leading-relaxed">
          <span className="text-fg font-medium">What we track:</span> page visits, when a validation check
          starts and completes, whether it succeeds or fails, and the MCP server URL you submit (so we can
          see which kinds of servers people are checking — not to identify you personally).
        </p>
        <p className="mt-4 text-sm text-fg/85 leading-relaxed">
          Your IP address is never sent to PostHog in raw form — it&rsquo;s cryptographically hashed
          (SHA-256) before being used to generate an anonymous identifier, so PostHog never receives your
          actual IP address.
        </p>
        <p className="mt-4 text-sm text-fg/85 leading-relaxed">
          Auth tokens (used for private/authenticated MCP servers) and API keys are never sent to PostHog
          under any circumstance, including in error logs — they are explicitly redacted before any error
          reporting occurs.
        </p>
        <p className="mt-4 text-sm text-fg/85 leading-relaxed">
          You can use Problex without any analytics tracking affecting your ability to run checks —
          analytics failures never block or degrade the core validation service.
        </p>

        <h2 className="mt-10 text-lg font-semibold text-fg">Third parties</h2>
        <p className="mt-3 text-sm text-fg/85 leading-relaxed">
          Scanned URLs and related data are processed by Anthropic (Claude API) to generate validation
          reports, and by Vercel, Upstash, and PostHog for hosting, rate limiting, and analytics. These
          providers process data on our behalf and are bound by their own privacy and security practices.
        </p>

        <h2 className="mt-10 text-lg font-semibold text-fg">Changes</h2>
        <p className="mt-3 text-sm text-fg/85 leading-relaxed">
          We may update this policy as Problex evolves (for example, if we introduce accounts or paid plans
          in the future). Material changes will be reflected on this page.
        </p>

        <h2 className="mt-10 text-lg font-semibold text-fg">Contact</h2>
        <p className="mt-3 text-sm text-fg/85 leading-relaxed">
          Questions or concerns can be raised via{' '}
          <a href={GITHUB_ISSUES_URL} target="_blank" rel="noopener noreferrer" className="text-suggestion hover:underline">
            GitHub Issues
          </a>.
        </p>
      </article>

      <Footer />
    </main>
  );
}
