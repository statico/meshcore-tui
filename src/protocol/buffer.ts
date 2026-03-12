// Binary buffer utilities for MeshCore protocol

export class BufferWriter {
  private buf: number[] = [];

  writeByte(v: number): this {
    this.buf.push(v & 0xff);
    return this;
  }

  writeUInt16LE(v: number): this {
    this.buf.push(v & 0xff, (v >> 8) & 0xff);
    return this;
  }

  writeUInt32LE(v: number): this {
    this.buf.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff);
    return this;
  }

  writeInt32LE(v: number): this {
    return this.writeUInt32LE(v >>> 0);
  }

  writeBytes(data: Uint8Array | number[]): this {
    for (const b of data) this.buf.push(b & 0xff);
    return this;
  }

  /** Write a string padded/truncated to exactly `len` bytes, null-terminated */
  writeFixedString(s: string, len: number): this {
    const encoded = new TextEncoder().encode(s);
    for (let i = 0; i < len; i++) {
      this.buf.push(i < encoded.length ? encoded[i] : 0);
    }
    return this;
  }

  /** Write a UTF-8 string (no length prefix, no padding) */
  writeString(s: string): this {
    const encoded = new TextEncoder().encode(s);
    this.writeBytes(encoded);
    return this;
  }

  toBytes(): Uint8Array {
    return new Uint8Array(this.buf);
  }

  get length(): number {
    return this.buf.length;
  }
}

export class BufferReader {
  private view: DataView;
  private bytes: Uint8Array;
  public offset = 0;

  constructor(data: Uint8Array) {
    this.bytes = data;
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  get remaining(): number {
    return this.bytes.length - this.offset;
  }

  readByte(): number {
    return this.bytes[this.offset++];
  }

  readUInt16LE(): number {
    const v = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return v;
  }

  readUInt32LE(): number {
    const v = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return v;
  }

  readInt32LE(): number {
    const v = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return v;
  }

  readBytes(len: number): Uint8Array {
    const slice = this.bytes.slice(this.offset, this.offset + len);
    this.offset += len;
    return slice;
  }

  /** Read a null-terminated string from a fixed-length field */
  readFixedString(len: number): string {
    const raw = this.readBytes(len);
    const end = raw.indexOf(0);
    return new TextDecoder().decode(end >= 0 ? raw.slice(0, end) : raw);
  }

  /** Read remaining bytes as UTF-8 string */
  readRemainingString(): string {
    return new TextDecoder().decode(this.readBytes(this.remaining));
  }

  readRemainingBytes(): Uint8Array {
    return this.readBytes(this.remaining);
  }
}

export function toHex(data: Uint8Array): string {
  return Array.from(data)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function pubKeyShort(key: Uint8Array): string {
  return toHex(key.slice(0, 4));
}
