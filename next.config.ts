import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  // 明确指定输出追踪根目录，消除 workspace root 推断警告
  outputFileTracingRoot: path.join(__dirname),
};

export default nextConfig;
