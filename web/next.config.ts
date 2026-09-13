import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  /**
   * Every route here is static: the landing, the docs, the token page and
   * the game client, which talks to the world server from the browser.
   * Nothing needs a Node runtime at request time, so the build produces a
   * plain folder of files that any host can serve. That is also what lets
   * the root `vercel.json` deploy this app out of a repository whose root
   * is a monorepo rather than a Next project.
   */
  output: "export",
  images: { unoptimized: true },
};

export default nextConfig;
