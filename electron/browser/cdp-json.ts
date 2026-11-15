import http from "node:http";

// Plain node only: the login-recovery and background-service paths read the browser debug port through this file, so it never imports "electron".
/** Bounded loopback JSON fetch; exported only for the private transport contract. */
export function fetchCdpJson(port: number, pathname: "/json/version" | "/json/list"): Promise<unknown | null> {
  return new Promise((resolve) => {
    let settled = false;
    let responseRef: http.IncomingMessage | null = null;
    let deadline: NodeJS.Timeout | null = null;
    const finish = (value: unknown | null) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      responseRef?.destroy();
      req.destroy();
      resolve(value);
    };
    const req = http.get(
      { host: "127.0.0.1", port, path: pathname },
      (response) => {
        responseRef = response;
        if (response.statusCode !== 200) {
          finish(null);
          return;
        }
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          if (body.length + chunk.length > 1024 * 1024) {
            finish(null);
            return;
          }
          body += chunk;
        });
        response.on("end", () => {
          try { finish(JSON.parse(body)); }
          catch { finish(null); }
        });
        response.once("aborted", () => finish(null));
        response.once("error", () => finish(null));
      },
    );
    deadline = setTimeout(() => finish(null), 2_000);
    req.once("error", () => finish(null));
    req.setTimeout(1_500);
    req.once("timeout", () => {
      finish(null);
    });
  });
}
