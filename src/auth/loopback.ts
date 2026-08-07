/**
 * RFC 8252 loopback 回调 —— `authDesktopCallbackUrl` 为空时的登录回落路径。
 *
 * 契约源：参考仓 `apps/desktop/src/main/authManager.ts`（openLoopbackBrowserAuthorization）
 * + `apps/desktop/src/main/authLoopbackCallback.ts`（parseAuthLoopbackCallback）。
 *
 * 语义对齐：
 *  - 回调路径固定 `/auth/callback`，未知路径 404 且不结算本次尝试；
 *  - `state` query 必须等于本次尝试的 expectedState（= authorize 的 client_state 哈希值），
 *    不匹配 → STATE_MISMATCH（防旁观者抢先消费授权码）；
 *  - provider error / 缺 code → 结构化 error，不抛异常；
 *  - 成功或失败均渲染简单 HTML 后关闭 server（浏览器 keep-alive 不阻塞换 token）。
 */
import http from "node:http";

export type LoopbackResult = { code: string } | { error: string };

/**
 * 解析 loopback 回调请求。纯函数：路径不匹配返回 null（调用方回 404 且不结算），
 * state 不匹配 / 带 error / 缺 code 返回结构化 error。
 */
export function parseAuthLoopbackCallback(
  requestUrl: string | undefined,
  expectedState: string,
): LoopbackResult | null {
  if (!requestUrl) return null;

  let callback: URL;
  try {
    callback = new URL(requestUrl, "http://127.0.0.1");
  } catch {
    return null;
  }

  if (callback.pathname !== "/auth/callback") return null;
  if (callback.searchParams.get("state") !== expectedState) {
    return { error: "STATE_MISMATCH" };
  }

  const providerError = callback.searchParams.get("error");
  if (providerError) return { error: providerError };

  const code = callback.searchParams.get("code");
  return code ? { code } : { error: "INVALID_AUTH_CODE" };
}

function renderPage(result: LoopbackResult): string {
  const isError = "error" in result;
  const title = isError ? "Login failed" : "Login successful";
  const body = isError ? `Error: ${result.error}` : "You can close this tab and return to Pi.";
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title></head>
<body style="font-family:system-ui;text-align:center;padding:48px">
<h2>${title}</h2><p>${body}</p></body></html>`;
}

/** 可监听型 loopback server：先取端口（redirect_uri），再等回调结果。 */
export interface LoopbackListener {
  redirectUri: string;
  result: Promise<LoopbackResult>;
}

/**
 * 启动 loopback server 并返回 { redirectUri, result }。
 * redirectUri = `http://127.0.0.1:<port>/auth/callback`（authorize URL 使用，须与
 * 服务端 loopback allowlist 一致）；result 在回调结算或超时时 resolve，无论成败
 * server 即关闭。listener 启动失败（端口等）→ reject。
 */
export function startLoopbackListener(
  expectedState: string,
  timeoutMs: number,
): Promise<LoopbackListener> {
  return new Promise((resolveOuter, rejectOuter) => {
    let settled = false;
    let server: http.Server | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const finish = (result: LoopbackResult) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      if (server && server.listening) server.close();
      // result promise 在内部结算（先于 finish 调用方注册）
      resultSettle(result);
    };
    let resultSettle: (r: LoopbackResult) => void = () => {};
    const result = new Promise<LoopbackResult>((r) => { resultSettle = r; });

    server = http.createServer((req, res) => {
      if (settled || !req.url) {
        res.writeHead(404).end();
        return;
      }
      const parsed = parseAuthLoopbackCallback(req.url, expectedState);
      if (!parsed) {
        res.writeHead(404).end();
        return;
      }
      const html = renderPage(parsed);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      finish(parsed);
    });

    server.once("error", (err) => {
      rejectOuter(new Error(`CALLBACK_LISTENER_FAILED:${err.message}`));
    });

    server.listen(0, "127.0.0.1", () => {
      if (settled) return;
      const address = server.address();
      if (!address || typeof address === "string") {
        rejectOuter(new Error("CALLBACK_LISTENER_FAILED:no-address"));
        return;
      }
      timer = setTimeout(() => finish({ error: "LOOPBACK_TIMEOUT" }), timeoutMs);
      resolveOuter({
        redirectUri: `http://127.0.0.1:${address.port}/auth/callback`,
        result,
      });
    });
  });
}
