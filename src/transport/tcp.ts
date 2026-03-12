// TCP transport for MeshCore companion radio WiFi interface

import { Socket } from "net";
import { EventEmitter } from "events";
import {
  FRAME_MARKER_TO_RADIO,
  FRAME_MARKER_FROM_RADIO,
  DEFAULT_TCP_PORT,
} from "../protocol/constants";

export interface TCPTransportOptions {
  host: string;
  port?: number;
}

export type ConnectionStatus = "disconnected" | "connecting" | "connected";

/**
 * TCP transport for MeshCore companion radio.
 * Handles frame-level protocol: [marker(1)] [length_le(2)] [payload(n)]
 */
export class TCPTransport extends EventEmitter {
  private socket: Socket | null = null;
  private recvBuf = Buffer.alloc(0);
  private host: string;
  private port: number;
  private _status: ConnectionStatus = "disconnected";

  constructor(opts: TCPTransportOptions) {
    super();
    this.host = opts.host;
    this.port = opts.port ?? DEFAULT_TCP_PORT;
  }

  get status(): ConnectionStatus {
    return this._status;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this._status = "connecting";
      this.emit("status", this._status);

      const socket = new Socket();
      socket.setTimeout(10000);

      socket.on("connect", () => {
        this._status = "connected";
        this.emit("status", this._status);
        socket.setTimeout(0);
        resolve();
      });

      socket.on("data", (data) => {
        this.recvBuf = Buffer.concat([this.recvBuf, data]);
        this.processFrames();
      });

      socket.on("error", (err) => {
        if (this._status === "connecting") {
          reject(err);
        }
        this.emit("error", err);
      });

      socket.on("close", () => {
        this._status = "disconnected";
        this.emit("status", this._status);
        this.emit("disconnected");
      });

      socket.on("timeout", () => {
        if (this._status === "connecting") {
          socket.destroy();
          reject(new Error("Connection timeout"));
        }
      });

      socket.connect(this.port, this.host);
      this.socket = socket;
    });
  }

  private processFrames(): void {
    while (this.recvBuf.length >= 3) {
      const marker = this.recvBuf[0];
      if (marker !== FRAME_MARKER_FROM_RADIO) {
        // Skip invalid byte
        this.recvBuf = this.recvBuf.subarray(1);
        continue;
      }
      const len = this.recvBuf[1] | (this.recvBuf[2] << 8);
      if (this.recvBuf.length < 3 + len) break; // Incomplete frame

      const payload = new Uint8Array(this.recvBuf.subarray(3, 3 + len));
      this.recvBuf = this.recvBuf.subarray(3 + len);
      this.emit("frame", payload);
    }
  }

  send(payload: Uint8Array): void {
    if (!this.socket || this._status !== "connected") {
      throw new Error("Not connected");
    }
    const header = Buffer.alloc(3);
    header[0] = FRAME_MARKER_TO_RADIO;
    header[1] = payload.length & 0xff;
    header[2] = (payload.length >> 8) & 0xff;
    this.socket.write(Buffer.concat([header, Buffer.from(payload)]));
  }

  disconnect(): void {
    this.socket?.destroy();
    this.socket = null;
    this._status = "disconnected";
  }
}
