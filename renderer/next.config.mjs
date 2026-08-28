// Electron의 file:// 로드 호환 — package build만 정적 export를 사용한다.
// NODE_ENV는 상위 셸/QA 런처에서 production으로 상속될 수 있다. 그것으로
// `next dev`를 export 설정으로 만들면 이미 열린 Electron의 dev 청크가 404가
// 되어 흰 화면이 된다. build:renderer가 명시적으로 쓰는 출력 디렉터리만
// 정적 export 경계로 사용한다.
const isStaticRendererBuild = process.env.AGENTLAS_NEXT_DIST_DIR === ".next-build";

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Keep production/export builds isolated from a concurrently running
  // `next dev` process. Both processes using `.next` can delete each other's
  // manifests and make an otherwise valid renderer build fail intermittently.
  distDir: process.env.AGENTLAS_NEXT_DIST_DIR || ".next",
  output: isStaticRendererBuild ? "export" : undefined,
  images: { unoptimized: true },
  trailingSlash: false,
  assetPrefix: isStaticRendererBuild ? "./" : undefined,
  // Vega's browser SVG renderer does not need the optional native `canvas`
  // package. Mark it external to the renderer bundle so webpack does not try
  // to resolve Vega's Node-only fallback (and so Desktop does not pull in a
  // native canvas binary just for Flint charts).
  webpack(config) {
    config.resolve ??= {};
    config.resolve.alias ??= {};
    config.resolve.alias.canvas = false;
    return config;
  },
};

export default nextConfig;
