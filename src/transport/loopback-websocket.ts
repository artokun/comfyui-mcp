import { EventEmitter } from "node:events";
import WebSocket, { type ClientOptions, type RawData } from "ws";
import { describeFetchFailure } from "../utils/errors.js";
import { formatComfyUIUrl } from "./comfyui-url.js";

type SocketEvent = "open" | "error" | "close" | "message";
type SocketListener = (...args: any[]) => void;

function isConnectionRefused(error: unknown): boolean {
  return describeFetchFailure(error).code === "ECONNREFUSED";
}

/**
 * A Node ws-compatible socket that preserves a literal loopback target for
 * the first dial and retries only a refused 127.0.0.1 connection at localhost.
 * The retry is safe because ECONNREFUSED proves the first handshake reached no
 * server; resets and timeouts are deliberately surfaced without re-issuing.
 *
 * The stable-canvas client consumes the DOM-style addEventListener surface,
 * while the MCP's direct monitors consume ws's EventEmitter surface. This
 * adapter exposes both and keeps the underlying socket private so a failed
 * first attempt cannot leak an error or close event before the fallback.
 */
export class LoopbackWebSocket extends EventEmitter {
  static readonly CONNECTING = WebSocket.CONNECTING;
  static readonly OPEN = WebSocket.OPEN;
  static readonly CLOSING = WebSocket.CLOSING;
  static readonly CLOSED = WebSocket.CLOSED;

  private socket: WebSocket;
  private readonly literalUrl: string;
  private fallbackTried = false;
  private callerClosed = false;
  private readonly options?: string | string[] | ClientOptions;
  private readonly domListeners = new Map<
    SocketEvent,
    Map<Function, SocketListener>
  >();

  constructor(url: string | URL, options?: string | string[] | ClientOptions) {
    super();
    const literalUrl = String(url);
    this.literalUrl = literalUrl;
    this.options = options;
    this.socket = this.open(literalUrl);
  }

  private open(url: string): WebSocket {
    const socket =
      this.options && typeof this.options === "object" && !Array.isArray(this.options)
        ? new WebSocket(url, this.options)
        : new WebSocket(url, this.options);
    socket.on("open", () => {
      if (socket !== this.socket) return;
      this.emit("open");
    });
    socket.on("message", (data: RawData, isBinary: boolean) => {
      if (socket !== this.socket) return;
      this.emit("message", data, isBinary);
    });
    socket.on("error", (error: Error) => {
      if (socket !== this.socket) return;
      if (
        !this.callerClosed &&
        !this.fallbackTried &&
        formatComfyUIUrl(this.literalUrl) !== url &&
        isConnectionRefused(error)
      ) {
        this.fallbackTried = true;
        const fallback = this.open(formatComfyUIUrl(this.literalUrl));
        this.socket = fallback;
        socket.terminate();
        return;
      }
      this.emit("error", error);
    });
    socket.on("close", (code: number, reason: Buffer) => {
      if (socket !== this.socket) return;
      this.emit("close", code, reason);
    });
    return socket;
  }

  get binaryType(): "nodebuffer" | "arraybuffer" | "fragments" {
    return this.socket.binaryType;
  }

  get CONNECTING(): number {
    return WebSocket.CONNECTING;
  }

  get OPEN(): number {
    return WebSocket.OPEN;
  }

  get CLOSING(): number {
    return WebSocket.CLOSING;
  }

  get CLOSED(): number {
    return WebSocket.CLOSED;
  }

  set binaryType(value: "nodebuffer" | "arraybuffer" | "fragments") {
    this.socket.binaryType = value;
  }

  get bufferedAmount(): number {
    return this.socket.bufferedAmount;
  }

  get extensions(): string {
    return this.socket.extensions;
  }

  get protocol(): string {
    return this.socket.protocol;
  }

  get readyState(): number {
    return this.socket.readyState;
  }

  get url(): string {
    return this.socket.url;
  }

  addEventListener(type: SocketEvent, listener: SocketListener): void {
    let listeners = this.domListeners.get(type);
    if (!listeners) {
      listeners = new Map();
      this.domListeners.set(type, listeners);
    }
    if (listeners.has(listener)) return;
    const adapted: SocketListener = (...args) => {
      const event =
        type === "message"
          ? { data: args[0] }
          : type === "close"
            ? { code: args[0], reason: args[1] }
            : args[0];
      listener.call(this, event);
    };
    listeners.set(listener, adapted);
    this.on(type, adapted);
  }

  removeEventListener(type: SocketEvent, listener: SocketListener): void {
    const listeners = this.domListeners.get(type);
    const adapted = listeners?.get(listener);
    if (!adapted) return;
    this.removeListener(type, adapted);
    listeners?.delete(listener);
  }

  send(data: Parameters<WebSocket["send"]>[0], ...args: any[]): void {
    this.socket.send(data, ...args);
  }

  close(code?: number, reason?: string | Buffer): void {
    this.callerClosed = true;
    this.socket.close(code, reason);
  }

  terminate(): void {
    this.callerClosed = true;
    this.socket.terminate();
  }
}
