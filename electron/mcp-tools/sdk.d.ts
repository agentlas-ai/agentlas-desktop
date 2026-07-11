// @modelcontextprotocol/sdk(1.x)는 package.json "exports" 맵으로 서브패스를 노출한다.
// electron tsconfig가 moduleResolution:"Node"(classic)라 tsc가 그 서브패스의 .d.ts를
// 찾지 못한다(런타임 Node는 exports를 honor하므로 require/import는 정상 동작).
// → 우리가 실제로 쓰는 최소 표면만 ambient module로 직접 선언한다.
declare module "@modelcontextprotocol/sdk/client/index.js" {
  export class Client {
    constructor(
      info: { name: string; version: string },
      opts?: { capabilities?: Record<string, unknown> },
    );
    connect(transport: unknown): Promise<void>;
    listTools(): Promise<{ tools: Array<{ name: string; description?: string }> }>;
    callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<unknown>;
    close(): Promise<void>;
  }
}

declare module "@modelcontextprotocol/sdk/client/stdio.js" {
  export class StdioClientTransport {
    constructor(opts: {
      command: string;
      args?: string[];
      env?: Record<string, string>;
      cwd?: string;
      stderr?: "overlapped" | "pipe" | "ignore" | "inherit";
    });
    close(): Promise<void>;
  }
  /** stdio 자식에 안전하게 상속할 기본 환경변수(PATH/HOME 등) */
  export function getDefaultEnvironment(): Record<string, string>;
}

declare module "@modelcontextprotocol/sdk/client/sse.js" {
  export class SSEClientTransport {
    constructor(url: URL, opts?: {
      eventSourceInit?: Record<string, unknown>;
      requestInit?: RequestInit;
      fetch?: typeof fetch;
    });
    close(): Promise<void>;
  }
}

declare module "@modelcontextprotocol/sdk/client/streamableHttp.js" {
  export class StreamableHTTPClientTransport {
    constructor(url: URL, opts?: { requestInit?: RequestInit });
    close(): Promise<void>;
  }
}
