// Electron의 file:// 로드 호환 — 프로덕션은 next export 정적 빌드.
// 주의: assetPrefix 분기는 NODE_ENV 기반.
//   - dev:        production이 아니므로 assetPrefix = undefined → /_next/... 절대 경로
//   - export 빌드: production이므로 assetPrefix = "./" → file:// 에서도 동작
//
// 이전 버전은 ELECTRON_START_URL 환경변수로 분기했는데, dev:renderer 스크립트가
// 그 환경변수를 next dev에 전달하지 않아서 dev에서도 "./" 가 적용 → 중첩 라우트의
// 청크 GET이 /library/_next/... 같은 상대 경로로 풀려 404 → client-side exception.
const isProd = process.env.NODE_ENV === "production";

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Keep production/export builds isolated from a concurrently running
  // `next dev` process. Both processes using `.next` can delete each other's
  // manifests and make an otherwise valid renderer build fail intermittently.
  distDir: process.env.AGENTLAS_NEXT_DIST_DIR || ".next",
  output: isProd ? "export" : undefined,
  images: { unoptimized: true },
  trailingSlash: false,
  assetPrefix: isProd ? "./" : undefined,
};

export default nextConfig;
