/**
 * Client-facing WebSocket support for `/v1/responses`.
 *
 * Newer Codex CLI clients can probe the Responses API with a WebSocket
 * upgrade and send `response.create` frames instead of using POST + SSE.
 * This module attaches a WebSocket server to the existing Node HTTP server,
 * dispatches each frame through the existing POST route, and converts the
 * resulting SSE events back into WebSocket JSON frames.
 *
 * The HTTP POST + SSE path remains the source of truth for authentication,
 * account selection, retries, translation, logging, and usage accounting.
 */

import { WebSocket, WebSocketServer } from "ws";
import type { Server, IncomingMessage } from "http";
import type { Duplex } from "stream";
import type { Hono } from "hono";
import type { AccountPool } from "../auth/account-pool.js";
import { getConfig } from "../config.js";
import { parseSSEStream } from "../proxy/codex-sse.js";

/** The only path this server accepts upgrades for. */
const UPGRADE_PATH = "/v1/responses";
const WS_OPEN = WebSocket.OPEN;

/**
 * Bound graceful shutdown time for client sockets. A peer that never
 * completes the WebSocket close handshake must not block server shutdown.
 */
const SHUTDOWN_CLOSE_TIMEOUT_MS = 1000;

/**
 * Headers that belong to the WebSocket handshake and must not be forwarded
 * to the synthetic HTTP POST request.
 */
const STRIPPED_HEADERS: ReadonlySet<string> = new Set([
  "connection",
  "content-length",
  "transfer-encoding",
  "host",
  "upgrade",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  "sec-websocket-protocol",
]);

export interface ResponsesWebSocketServerOptions {
  /** The Node HTTP server returned by @hono/node-server. */
  server: Server;
  /** The mounted Hono app exposing POST `/v1/responses`. */
  app: Hono;
  accountPool: AccountPool;
}

export class ResponsesWebSocketServer {
  private readonly server: Server;
  private readonly app: Hono;
  private readonly accountPool: AccountPool;
  private readonly wss: WebSocketServer;
  private readonly onUpgradeBound: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
  private closed = false;

  constructor(options: ResponsesWebSocketServerOptions) {
    this.server = options.server;
    this.app = options.app;
    this.accountPool = options.accountPool;

    this.wss = new WebSocketServer({ noServer: true });
    this.wss.on("connection", (ws, req) => this.handleConnection(ws, req));
    this.wss.on("error", (err) => {
      console.error("[responses-ws] WebSocketServer error:", err);
    });

    this.onUpgradeBound = (req, socket, head) => this.handleUpgrade(req, socket, head);
    this.server.on("upgrade", this.onUpgradeBound);
  }

  /** Detach the upgrade listener and close all client sockets. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.server.off("upgrade", this.onUpgradeBound);

    for (const client of this.wss.clients) {
      try {
        client.close(1000, "server shutdown");
      } catch {
        // The socket may already be closing.
      }
    }

    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };

      const timer = setTimeout(() => {
        for (const client of this.wss.clients) {
          try {
            client.terminate();
          } catch {
            // The socket may already be closed.
          }
        }
        done();
      }, SHUTDOWN_CLOSE_TIMEOUT_MS);
      timer.unref?.();

      try {
        this.wss.close(() => {
          clearTimeout(timer);
          done();
        });
      } catch {
        clearTimeout(timer);
        done();
      }
    });
  }

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://localhost");
    } catch {
      socket.destroy();
      return;
    }

    if (url.pathname !== UPGRADE_PATH) {
      // There is no other upgrade consumer on this server. Destroying an
      // unknown upgrade prevents an unhandled socket from hanging forever.
      socket.destroy();
      return;
    }

    const auth = this.authorize(req);
    if (!auth.allowed) {
      this.rejectUpgrade(socket, auth.statusCode, auth.message);
      return;
    }

    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.wss.emit("connection", ws, req);
    });
  }

  /** Match the existing HTTP `apiKeyAuth` behavior for the local service key. */
  private authorize(req: IncomingMessage): {
    allowed: boolean;
    statusCode: number;
    message: string;
  } {
    const key = this.extractProxyApiKey(req);
    if (key && this.accountPool.validateProxyApiKey(key)) {
      return { allowed: true, statusCode: 0, message: "" };
    }

    // Passthrough mode intentionally has no required API key, matching the
    // HTTP middleware's early return when proxy_api_key is not configured.
    const config = getConfig();
    if (!config.server.proxy_api_key) {
      return { allowed: true, statusCode: 0, message: "" };
    }

    return { allowed: false, statusCode: 401, message: "Invalid proxy API key" };
  }

  /**
   * Match `extractProxyApiKey()` locations used by HTTP routes. Keeping the
   * query string is important because the synthetic POST below must be able
   * to authenticate a `?key=` WebSocket client too.
   */
  private extractProxyApiKey(req: IncomingMessage): string | null {
    let queryKey: string | null = null;
    try {
      queryKey = new URL(req.url ?? "/", "http://localhost").searchParams.get("key");
    } catch {
      // Fall through to header extraction.
    }

    const googKey = this.headerValue(req.headers["x-goog-api-key"]);
    const xApiKey = this.headerValue(req.headers["x-api-key"]);
    const authHeader = this.headerValue(req.headers.authorization);
    const bearerKey = authHeader ? authHeader.replace(/^bearer\s+/i, "") : null;
    return queryKey ?? googKey ?? xApiKey ?? (bearerKey || null);
  }

  private headerValue(value: string | string[] | undefined): string | null {
    if (typeof value === "string" && value.length > 0) return value;
    if (Array.isArray(value) && value.length > 0) return value[0];
    return null;
  }

  private rejectUpgrade(socket: Duplex, status: number, message: string): void {
    const reason =
      status === 401 ? "Unauthorized"
        : status === 403 ? "Forbidden"
          : status === 429 ? "Too Many Requests"
            : "Error";
    const body = `${message}\n`;
    socket.write(
      `HTTP/1.1 ${status} ${reason}\r\n` +
        "Content-Type: text/plain\r\n" +
        "Connection: close\r\n" +
        `Content-Length: ${Buffer.byteLength(body)}\r\n` +
        "\r\n" +
        body,
    );
    socket.destroy();
  }

  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    let busy = false;
    const abortController = new AbortController();

    ws.on("message", (data) => {
      // A Responses connection processes one response.create at a time.
      if (busy) {
        this.sendErrorFrame(ws, JSON.stringify({
          type: "error",
          error: {
            type: "server_error",
            code: "connection_busy",
            message: "A response.create is already in progress on this connection",
          },
        }));
        return;
      }

      busy = true;
      const raw = typeof data === "string" ? data : (data as Buffer).toString("utf-8");
      void this.dispatch(ws, req, raw, abortController.signal)
        .catch((err: unknown) => {
          if (abortController.signal.aborted || this.isAbortError(err)) return;
          const message = err instanceof Error ? err.message : String(err);
          this.sendErrorFrame(ws, message);
        })
        .finally(() => {
          busy = false;
        });
    });

    // Never let a client-side EventEmitter error become a process-level
    // uncaught error. Close only this connection instead.
    ws.on("error", () => {
      try {
        ws.close(1011, "internal error");
      } catch {
        ws.terminate();
      }
    });

    // Cancels the synthetic POST and its upstream stream when the client
    // disconnects, allowing account slots and transport resources to release.
    ws.on("close", () => {
      abortController.abort();
    });
  }

  /** Dispatch one frame through POST `/v1/responses` and forward SSE data. */
  private async dispatch(
    ws: WebSocket,
    req: IncomingMessage,
    body: string,
    signal: AbortSignal,
  ): Promise<void> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === "string" && !STRIPPED_HEADERS.has(key.toLowerCase())) {
        headers[key.toLowerCase()] = value;
      }
    }

    let dispatchPath = UPGRADE_PATH;
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      dispatchPath = `${url.pathname}${url.search}`;
    } catch {
      // `handleUpgrade` already validated the URL. Keep the safe path if it
      // becomes malformed between the two operations.
    }

    const response = await this.app.request(dispatchPath, {
      method: "POST",
      headers,
      body,
      signal,
    });

    const contentType = response.headers.get("content-type") ?? "";
    if (!response.ok || !contentType.includes("text/event-stream")) {
      const textBody = await response.text();
      this.sendErrorFrame(ws, textBody);
      return;
    }

    try {
      for await (const event of parseSSEStream(response)) {
        if (ws.readyState !== WS_OPEN || signal.aborted) break;
        try {
          ws.send(JSON.stringify(event.data));
        } catch {
          // The client may have closed between the readyState check and send.
          break;
        }
      }
    } finally {
      // Cancel a still-open response body when the client disconnects or the
      // stream terminates early.
      try {
        await response.body?.cancel();
      } catch {
        // The body may already be closed.
      }
    }
  }

  /** Normalize route errors into typed Responses WebSocket error frames. */
  private sendErrorFrame(ws: WebSocket, rawMessage: string): void {
    let errorType = "server_error";
    let code = "proxy_error";
    let message = rawMessage;

    try {
      const parsed = JSON.parse(rawMessage) as Record<string, unknown>;
      const errObj =
        parsed && typeof parsed.error === "object" && parsed.error !== null
          ? parsed.error as Record<string, unknown>
          : undefined;
      message =
        typeof errObj?.message === "string"
          ? errObj.message
          : typeof parsed.message === "string"
            ? parsed.message
            : rawMessage;
      if (typeof errObj?.type === "string") errorType = errObj.type;
      if (typeof errObj?.code === "string") code = errObj.code;
    } catch {
      // Keep the raw text for non-JSON errors.
    }

    if (ws.readyState !== WS_OPEN) return;
    try {
      ws.send(JSON.stringify({
        type: "error",
        error: { type: errorType, code, message },
      }));
    } catch {
      // The socket may have closed after the readyState check.
    }
  }

  private isAbortError(err: unknown): boolean {
    return err instanceof Error && err.name === "AbortError";
  }
}
