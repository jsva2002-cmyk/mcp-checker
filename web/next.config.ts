import type { NextConfig } from 'next';
import path from 'path';

const nextConfig: NextConfig = {
  // The repo has a second package-lock.json at the parent (CLI) project root,
  // which makes Next.js infer the wrong workspace root and warn about multiple
  // lockfiles. Pin it explicitly to this directory.
  outputFileTracingRoot: path.join(__dirname),
};

export default nextConfig;
