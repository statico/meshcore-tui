// MeshCore protocol client - command/response layer over transport

import { EventEmitter } from "events";
import { TCPTransport, type ConnectionStatus } from "../transport/tcp";
import { BufferWriter, BufferReader, pubKeyShort, toHex } from "./buffer";
import {
  CommandCode,
  ResponseCode,
  PushCode,
  ContactType,
  contactTypeName,
  MAX_MSG_LENGTH,
  type ErrorCode,
} from "./constants";

export interface Contact {
  publicKey: Uint8Array;
  publicKeyHex: string;
  type: ContactType;
  typeName: string;
  flags: number;
  pathLen: number;
  path: Uint8Array;
  name: string;
  lastAdvert: number;
  lat: number;
  lon: number;
  lastMod: number;
}

export interface SelfInfo {
  type: number;
  txPower: number;
  maxTxPower: number;
  publicKey: Uint8Array;
  lat: number;
  lon: number;
  multiAcks: number;
  advertLocPolicy: number;
  telemetryMode: number;
  manualAddContacts: number;
  freq: number;
  bw: number;
  sf: number;
  cr: number;
  name: string;
}

export interface DeviceInfo {
  firmwareVer: number;
  maxContacts: number;
  maxChannels: number;
  blePin: number;
  buildDate: string;
  model: string;
  firmwareVersion: string;
}

export interface ChannelInfo {
  index: number;
  name: string;
  secret: Uint8Array;
}

export interface ReceivedMessage {
  type: "contact" | "channel";
  senderKey: Uint8Array;
  senderName?: string;
  channelIdx?: number;
  text: string;
  timestamp: number;
  snr?: number;
  pathLen?: number;
}

export interface BatteryInfo {
  millivolts: number;
  percentage: number;
  storageUsedKB: number;
  storageTotalKB: number;
}

const RESPONSE_TIMEOUT = 5000;

/** Convert millivolts to approximate battery percentage (LiPo 3.0V-4.2V) */
function mvToPercent(mv: number): number {
  if (mv >= 4200) return 100;
  if (mv <= 3000) return 0;
  return Math.round(((mv - 3000) / 1200) * 100);
}

export class MeshCoreClient extends EventEmitter {
  private transport: TCPTransport;
  private pendingResolve: ((frame: Uint8Array) => void) | null = null;
  private _contacts: Map<string, Contact> = new Map();
  private _selfInfo: SelfInfo | null = null;
  private _deviceInfo: DeviceInfo | null = null;

  constructor(host: string, port?: number) {
    super();
    this.transport = new TCPTransport({ host, port });
    this.transport.on("frame", (frame: Uint8Array) => this.handleFrame(frame));
    this.transport.on("status", (s: ConnectionStatus) => this.emit("status", s));
    this.transport.on("disconnected", () => this.emit("disconnected"));
    this.transport.on("error", (e: Error) => this.emit("error", e));
  }

  get status(): ConnectionStatus {
    return this.transport.status;
  }
  get contacts(): Map<string, Contact> {
    return this._contacts;
  }
  get selfInfo(): SelfInfo | null {
    return this._selfInfo;
  }
  get deviceInfo(): DeviceInfo | null {
    return this._deviceInfo;
  }

  async connect(): Promise<void> {
    await this.transport.connect();
  }

  disconnect(): void {
    this.transport.disconnect();
  }

  private handleFrame(frame: Uint8Array): void {
    if (frame.length === 0) return;
    const code = frame[0];

    // Push codes are unsolicited — emit events
    if (code >= 0x80) {
      this.handlePush(code, frame.slice(1));
      return;
    }

    // Response to a pending command
    if (this.pendingResolve) {
      this.pendingResolve(frame);
      this.pendingResolve = null;
    }
  }

  private handlePush(code: number, data: Uint8Array): void {
    switch (code) {
      case PushCode.MSG_WAITING:
        this.emit("messages_waiting");
        break;
      case PushCode.ADVERT:
      case PushCode.NEW_ADVERT:
        this.emit("advert", data);
        break;
      case PushCode.PATH_UPDATED:
        this.emit("path_updated", data);
        break;
      case PushCode.SEND_CONFIRMED:
        this.emit("send_confirmed", data);
        break;
      case PushCode.STATUS_RESPONSE:
        this.emit("status_response", data);
        break;
      case PushCode.TELEMETRY_RESPONSE:
        this.emit("telemetry_response", data);
        break;
      case PushCode.TRACE_DATA:
        this.emit("trace_data", data);
        break;
      case PushCode.PATH_DISCOVERY_RESPONSE:
        this.emit("path_discovery_response", data);
        break;
      case PushCode.LOG_RX_DATA:
        this.emit("log_rx_data", data);
        break;
      case PushCode.CONTACT_DELETED:
        this.emit("contact_deleted", data);
        break;
      case PushCode.CONTACTS_FULL:
        this.emit("contacts_full");
        break;
      default:
        this.emit("push", { code, data });
    }
  }

  /** Send a command and wait for a single response frame */
  private sendCommand(payload: Uint8Array): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingResolve = null;
        reject(new Error("Command timeout"));
      }, RESPONSE_TIMEOUT);

      this.pendingResolve = (frame) => {
        clearTimeout(timeout);
        resolve(frame);
      };

      this.transport.send(payload);
    });
  }

  /**
   * Send a command and collect all response frames until a terminator.
   * Used for multi-frame responses like contact lists.
   */
  private sendCommandMulti(
    payload: Uint8Array,
    terminators: number[],
  ): Promise<Uint8Array[]> {
    return new Promise((resolve, reject) => {
      const frames: Uint8Array[] = [];
      const timeout = setTimeout(() => {
        this.pendingResolve = null;
        // If we have some frames, return them instead of erroring
        if (frames.length > 0) {
          resolve(frames);
        } else {
          reject(new Error("Command timeout (multi)"));
        }
      }, 30000);

      const handler = (frame: Uint8Array) => {
        frames.push(frame);
        if (frame.length > 0 && terminators.includes(frame[0])) {
          clearTimeout(timeout);
          this.pendingResolve = null;
          resolve(frames);
        } else {
          // Keep waiting for more frames
          this.pendingResolve = handler;
        }
      };

      this.pendingResolve = handler;
      this.transport.send(payload);
    });
  }

  /** Drain any stale frames by briefly accepting and discarding them */
  async drainFrames(ms = 200): Promise<void> {
    return new Promise((resolve) => {
      const drain = () => { this.pendingResolve = drain; };
      this.pendingResolve = drain;
      setTimeout(() => {
        this.pendingResolve = null;
        resolve();
      }, ms);
    });
  }

  // ─── High-level commands ─────────────────────────────────────

  async appStart(appName = "mccli"): Promise<SelfInfo> {
    const w = new BufferWriter();
    w.writeByte(CommandCode.APP_START);
    w.writeByte(0x01); // appVer
    w.writeBytes(new Uint8Array(6)); // reserved
    w.writeString(appName);
    const resp = await this.sendCommand(w.toBytes());
    if (resp[0] !== ResponseCode.SELF_INFO) {
      throw new Error(`APP_START failed: code ${resp[0]}`);
    }
    const body = resp.slice(1);
    const r = new BufferReader(body);

    // Debug: dump full raw hex for protocol debugging
    console.error(
      `[DEBUG] SELF_INFO raw (${resp.length} bytes): ${toHex(resp)}`,
    );

    const type = r.readByte();
    const txPower = r.readByte();
    const maxTxPower = r.readByte();
    const publicKey = r.readBytes(32);
    const lat = r.readInt32LE() / 1e6;
    const lon = r.readInt32LE() / 1e6;

    // After base fields (43 bytes), the remaining bytes contain radio params + name.
    // The number of skip bytes before freq varies by firmware version.
    // Auto-detect by scanning for a plausible freq value (100-1000 MHz range).
    const savedOffset = r.offset;
    let skipBytes = 0;
    let freq = 0, bw = 0, sf = 0, cr = 0;
    let foundParams = false;

    for (let skip = 0; skip <= Math.min(8, r.remaining - 11); skip++) {
      r.offset = savedOffset + skip;
      const testFreq = r.readUInt32LE() / 1000;
      const testBw = r.readUInt32LE() / 1000;
      const testSf = r.readByte();
      const testCr = r.readByte();

      if (testFreq >= 100 && testFreq <= 1000 &&
          testBw >= 5 && testBw <= 600 &&
          testSf >= 5 && testSf <= 12 &&
          testCr >= 1 && testCr <= 8) {
        freq = testFreq;
        bw = testBw;
        sf = testSf;
        cr = testCr;
        skipBytes = skip;
        foundParams = true;
        console.error(`[DEBUG] Found radio params at skip=${skip} from offset ${savedOffset}: freq=${freq} bw=${bw} sf=${sf} cr=${cr}`);
        break;
      }
    }

    if (!foundParams) {
      // Fallback: just read from current position
      r.offset = savedOffset + 1; // skip 1 byte (manualAddContacts)
      freq = r.remaining >= 4 ? r.readUInt32LE() / 1000 : 0;
      bw = r.remaining >= 4 ? r.readUInt32LE() / 1000 : 0;
      sf = r.remaining >= 1 ? r.readByte() : 0;
      cr = r.remaining >= 1 ? r.readByte() : 0;
      console.error(`[DEBUG] Radio params NOT auto-detected, fallback: freq=${freq} bw=${bw} sf=${sf} cr=${cr}`);
    }

    const manualAddContacts = skipBytes > 0 ? body[savedOffset] : 0;
    const name = r.remaining > 0 ? r.readRemainingString() : "";

    console.error(
      `[DEBUG] Parsed SelfInfo: skip=${skipBytes} freq=${freq} bw=${bw} sf=${sf} cr=${cr} name="${name}"`,
    );

    const info: SelfInfo = {
      type,
      txPower,
      maxTxPower,
      publicKey,
      lat,
      lon,
      multiAcks: 0,
      advertLocPolicy: 0,
      telemetryMode: 0,
      manualAddContacts,
      freq,
      bw,
      sf,
      cr,
      name,
    };
    this._selfInfo = info;
    return info;
  }

  async deviceQuery(appTargetVer = 3): Promise<DeviceInfo> {
    const w = new BufferWriter();
    w.writeByte(CommandCode.DEVICE_QUERY);
    w.writeByte(appTargetVer);
    const resp = await this.sendCommand(w.toBytes());
    if (resp[0] !== ResponseCode.DEVICE_INFO) {
      throw new Error(`DEVICE_QUERY failed: code ${resp[0]}`);
    }
    const r = new BufferReader(resp.slice(1));

    // Debug: dump full raw hex
    console.error(
      `[DEBUG] DEVICE_INFO raw (${resp.length} bytes): ${toHex(resp)}`,
    );

    const firmwareVer = r.readByte();
    const maxContactsRaw = r.readByte();
    const maxChannels = r.readByte();
    const blePin = r.readUInt32LE();
    const buildDate = r.readFixedString(12);

    // Remaining bytes are model + firmwareVersion strings.
    // Try different field sizes to find the split point.
    // The model and firmware version are null-terminated within their fields.
    const remainingStr = r.remaining > 0 ? r.readRemainingBytes() : new Uint8Array(0);

    // Find the first null-terminated string (model), then the second (firmware version)
    let model = "";
    let firmwareVersion = "";
    if (remainingStr.length > 0) {
      // Scan for pattern: model string, then padding zeros, then firmware string
      const firstNull = remainingStr.indexOf(0);
      if (firstNull >= 0) {
        model = new TextDecoder().decode(remainingStr.slice(0, firstNull));
        // Find where the next non-zero byte starts (firmware version)
        let fwStart = firstNull + 1;
        while (fwStart < remainingStr.length && remainingStr[fwStart] === 0) fwStart++;
        if (fwStart < remainingStr.length) {
          const fwEnd = remainingStr.indexOf(0, fwStart);
          firmwareVersion = new TextDecoder().decode(
            remainingStr.slice(fwStart, fwEnd >= 0 ? fwEnd : remainingStr.length),
          );
        }
      } else {
        model = new TextDecoder().decode(remainingStr);
      }
    }

    console.error(
      `[DEBUG] Parsed DeviceInfo: firmwareVer=${firmwareVer} model="${model}" firmwareVersion="${firmwareVersion}" buildDate="${buildDate}" remainingLen=${remainingStr.length}`,
    );
    const info: DeviceInfo = {
      firmwareVer,
      maxContacts: maxContactsRaw * 2,
      maxChannels,
      blePin,
      buildDate,
      model,
      firmwareVersion,
    };
    this._deviceInfo = info;
    return info;
  }

  async setDeviceTime(timestamp?: number): Promise<void> {
    const w = new BufferWriter();
    w.writeByte(CommandCode.SET_DEVICE_TIME);
    w.writeUInt32LE(timestamp ?? Math.floor(Date.now() / 1000));
    const resp = await this.sendCommand(w.toBytes());
    if (resp[0] !== ResponseCode.OK) {
      throw new Error(`SET_DEVICE_TIME failed: code ${resp[0]}`);
    }
  }

  async getContacts(since = 0): Promise<Contact[]> {
    const w = new BufferWriter();
    w.writeByte(CommandCode.GET_CONTACTS);
    if (since > 0) w.writeUInt32LE(since);
    const frames = await this.sendCommandMulti(w.toBytes(), [
      ResponseCode.END_OF_CONTACTS,
      ResponseCode.ERR,
    ]);

    const contacts: Contact[] = [];
    for (const frame of frames) {
      if (frame[0] === ResponseCode.CONTACT) {
        const c = this.parseContact(frame.slice(1));
        contacts.push(c);
        this._contacts.set(toHex(c.publicKey), c);
      }
    }
    return contacts;
  }

  private parseContact(data: Uint8Array): Contact {
    const r = new BufferReader(data);
    const publicKey = r.readBytes(32);
    const type = r.readByte() as ContactType;
    const flags = r.readByte();
    const pathLenByte = r.readByte();
    // 0xFF means unknown/flood path
    const pathLen = pathLenByte === 0xff ? 0 : pathLenByte;
    const maxPath = 64;
    const path = r.readBytes(maxPath);
    const name = r.readFixedString(32);
    const lastAdvert = r.readUInt32LE();
    const lat = r.remaining >= 4 ? r.readInt32LE() / 1e6 : 0;
    const lon = r.remaining >= 4 ? r.readInt32LE() / 1e6 : 0;
    const lastMod = r.remaining >= 4 ? r.readUInt32LE() : 0;

    return {
      publicKey,
      publicKeyHex: toHex(publicKey),
      type,
      typeName: contactTypeName[type] ?? "unknown",
      flags,
      pathLen,
      path: path.slice(0, pathLen),
      name,
      lastAdvert,
      lat,
      lon,
      lastMod,
    };
  }

  async sendTextMessage(pubKey: Uint8Array, text: string): Promise<void> {
    if (text.length > MAX_MSG_LENGTH) {
      text = text.slice(0, MAX_MSG_LENGTH);
    }
    const w = new BufferWriter();
    w.writeByte(CommandCode.SEND_TXT_MSG);
    w.writeByte(0x00); // txt_type: plain
    w.writeByte(0x00); // attempt
    w.writeUInt32LE(Math.floor(Date.now() / 1000));
    w.writeBytes(pubKey.slice(0, 6)); // 6-byte prefix
    w.writeString(text);
    const resp = await this.sendCommand(w.toBytes());
    if (resp[0] === ResponseCode.ERR) {
      throw new Error(`Send message failed: error ${resp[1]}`);
    }
  }

  async sendChannelMessage(channelIdx: number, text: string): Promise<void> {
    if (text.length > MAX_MSG_LENGTH) {
      text = text.slice(0, MAX_MSG_LENGTH);
    }
    const w = new BufferWriter();
    w.writeByte(CommandCode.SEND_CHANNEL_TXT_MSG);
    w.writeByte(0x00); // txt_type: plain
    w.writeByte(channelIdx);
    w.writeUInt32LE(Math.floor(Date.now() / 1000));
    w.writeString(text);
    const resp = await this.sendCommand(w.toBytes());
    if (resp[0] === ResponseCode.ERR) {
      throw new Error(`Send channel message failed: error ${resp[1]}`);
    }
  }

  async syncNextMessage(): Promise<ReceivedMessage | null> {
    const w = new BufferWriter();
    w.writeByte(CommandCode.SYNC_NEXT_MESSAGE);
    const resp = await this.sendCommand(w.toBytes());

    switch (resp[0]) {
      case ResponseCode.NO_MORE_MESSAGES:
        return null;

      case ResponseCode.CONTACT_MSG_RECV: {
        // Non-V3: [pubKeyPrefix(6)] [pathLen(1)] [txtType(1)] [timestamp(4)] [text...]
        const r = new BufferReader(resp.slice(1));
        const senderKey = r.readBytes(6);
        const pathLen = r.readByte();
        const txtType = r.readByte();
        const timestamp = r.readUInt32LE();
        // If txtType == 2 (signed), skip 4-byte signature
        if (txtType === 2 && r.remaining >= 4) r.readBytes(4);
        const text = r.readRemainingString();
        return { type: "contact", senderKey, text, timestamp, pathLen };
      }

      case ResponseCode.CONTACT_MSG_RECV_V3: {
        // V3: [snr(1)] [reserved(2)] [pubKeyPrefix(6)] [pathLen(1)] [txtType(1)] [timestamp(4)] [text...]
        const r = new BufferReader(resp.slice(1));
        const snrByte = r.readByte();
        const snr = (snrByte > 127 ? snrByte - 256 : snrByte) / 4.0;
        r.readBytes(2); // reserved
        const senderKey = r.readBytes(6);
        const pathLen = r.readByte();
        const txtType = r.readByte();
        const timestamp = r.readUInt32LE();
        if (txtType === 2 && r.remaining >= 4) r.readBytes(4);
        const text = r.readRemainingString();
        return { type: "contact", senderKey, text, timestamp, snr, pathLen };
      }

      case ResponseCode.CHANNEL_MSG_RECV: {
        // Non-V3: [channelIdx(1)] [pathLen(1)] [txtType(1)] [timestamp(4)] [text...]
        const r = new BufferReader(resp.slice(1));
        const channelIdx = r.readByte();
        const pathLen = r.readByte();
        const txtType = r.readByte();
        const timestamp = r.readUInt32LE();
        const text = r.readRemainingString();
        return {
          type: "channel",
          channelIdx,
          senderKey: new Uint8Array(0), // channel msgs have no sender key
          text,
          timestamp,
          pathLen,
        };
      }

      case ResponseCode.CHANNEL_MSG_RECV_V3: {
        // V3: [snr(1)] [reserved(2)] [channelIdx(1)] [pathLen(1)] [txtType(1)] [timestamp(4)] [text...]
        const r = new BufferReader(resp.slice(1));
        const snrByte = r.readByte();
        const snr = (snrByte > 127 ? snrByte - 256 : snrByte) / 4.0;
        r.readBytes(2); // reserved
        const channelIdx = r.readByte();
        const pathLen = r.readByte();
        const txtType = r.readByte();
        const timestamp = r.readUInt32LE();
        const text = r.readRemainingString();
        return {
          type: "channel",
          channelIdx,
          senderKey: new Uint8Array(0),
          text,
          timestamp,
          snr,
          pathLen,
        };
      }

      default:
        return null;
    }
  }

  /** Drain all pending messages */
  async syncAllMessages(): Promise<ReceivedMessage[]> {
    const msgs: ReceivedMessage[] = [];
    for (;;) {
      const msg = await this.syncNextMessage();
      if (!msg) break;
      msgs.push(msg);
    }
    return msgs;
  }

  async getBattery(): Promise<BatteryInfo> {
    const w = new BufferWriter();
    w.writeByte(CommandCode.GET_BATT_AND_STORAGE);
    const resp = await this.sendCommand(w.toBytes());
    if (resp[0] !== ResponseCode.BATT_AND_STORAGE) {
      throw new Error(`GET_BATT failed: code ${resp[0]}`);
    }
    const r = new BufferReader(resp.slice(1));
    const millivolts = r.readUInt16LE();
    const storageUsedKB = r.remaining >= 4 ? r.readUInt32LE() : 0;
    const storageTotalKB = r.remaining >= 4 ? r.readUInt32LE() : 0;
    return {
      millivolts,
      percentage: mvToPercent(millivolts),
      storageUsedKB,
      storageTotalKB,
    };
  }

  async getChannel(idx: number, retries = 2): Promise<ChannelInfo> {
    for (let attempt = 0; attempt <= retries; attempt++) {
      const w = new BufferWriter();
      w.writeByte(CommandCode.GET_CHANNEL);
      w.writeByte(idx);
      const resp = await this.sendCommand(w.toBytes());
      if (resp[0] === ResponseCode.CHANNEL_INFO) {
        const r = new BufferReader(resp.slice(1));
        const index = r.readByte();
        const name = r.readFixedString(32);
        const secret = r.readBytes(16);
        return { index, name, secret };
      }
      // Got a stale frame from a previous command — retry
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 100));
        continue;
      }
      throw new Error(`GET_CHANNEL(${idx}) failed: code ${resp[0]} (0x${resp[0].toString(16)}) len=${resp.length}`);
    }
    throw new Error(`GET_CHANNEL(${idx}) failed after retries`);
  }

  async setChannel(idx: number, name: string, secret: Uint8Array): Promise<void> {
    const w = new BufferWriter();
    w.writeByte(CommandCode.SET_CHANNEL);
    w.writeByte(idx);
    w.writeFixedString(name, 32);
    w.writeBytes(secret.slice(0, 16)); // firmware expects exactly 16 bytes
    const resp = await this.sendCommand(w.toBytes());
    // Firmware responds with CHANNEL_INFO (0x12) on success, not OK
    if (resp[0] !== ResponseCode.OK && resp[0] !== ResponseCode.CHANNEL_INFO) {
      throw new Error(`SET_CHANNEL failed: code ${resp[0]}`);
    }
  }

  async sendAdvert(type: number = 1): Promise<void> {
    const w = new BufferWriter();
    w.writeByte(CommandCode.SEND_SELF_ADVERT);
    w.writeByte(type); // 0=ZeroHop, 1=Flood
    const resp = await this.sendCommand(w.toBytes());
    if (resp[0] !== ResponseCode.OK) {
      throw new Error(`SEND_ADVERT failed: code ${resp[0]}`);
    }
  }

  async setAdvertName(name: string): Promise<void> {
    const w = new BufferWriter();
    w.writeByte(CommandCode.SET_ADVERT_NAME);
    w.writeString(name); // variable-length, not fixed
    const resp = await this.sendCommand(w.toBytes());
    if (resp[0] !== ResponseCode.OK) {
      throw new Error(`SET_ADVERT_NAME failed: code ${resp[0]}`);
    }
  }

  async removeContact(publicKey: Uint8Array): Promise<void> {
    const w = new BufferWriter();
    w.writeByte(CommandCode.REMOVE_CONTACT);
    w.writeBytes(publicKey.slice(0, 32)); // full 32-byte key required
    const resp = await this.sendCommand(w.toBytes());
    if (resp[0] !== ResponseCode.OK) {
      throw new Error(`REMOVE_CONTACT failed: code ${resp[0]}`);
    }
  }

  /** Request status/telemetry from a contact */
  async sendStatusRequest(publicKey: Uint8Array): Promise<void> {
    const w = new BufferWriter();
    w.writeByte(CommandCode.SEND_STATUS_REQ);
    w.writeBytes(publicKey.slice(0, 32));
    const resp = await this.sendCommand(w.toBytes());
    if (resp[0] !== ResponseCode.OK && resp[0] !== ResponseCode.MSG_SENT) {
      throw new Error(`SEND_STATUS_REQ failed: code ${resp[0]}`);
    }
  }

  /** Request path discovery (traceroute) to a contact */
  async sendPathDiscovery(publicKey: Uint8Array): Promise<void> {
    const w = new BufferWriter();
    w.writeByte(CommandCode.SEND_PATH_DISCOVERY_REQ);
    w.writeBytes(publicKey.slice(0, 32));
    const resp = await this.sendCommand(w.toBytes());
    if (resp[0] !== ResponseCode.OK && resp[0] !== ResponseCode.MSG_SENT) {
      throw new Error(`SEND_PATH_DISCOVERY_REQ failed: code ${resp[0]}`);
    }
  }

  async resetPath(publicKey: Uint8Array): Promise<void> {
    const w = new BufferWriter();
    w.writeByte(CommandCode.RESET_PATH);
    w.writeBytes(publicKey.slice(0, 32)); // full 32-byte key required
    const resp = await this.sendCommand(w.toBytes());
    if (resp[0] !== ResponseCode.OK) {
      throw new Error(`RESET_PATH failed: code ${resp[0]}`);
    }
  }

  async reboot(): Promise<void> {
    const w = new BufferWriter();
    w.writeByte(CommandCode.REBOOT);
    w.writeString("reboot"); // safety confirmation string required by firmware
    this.transport.send(w.toBytes());
    // No response expected — device reboots
  }

  async getDeviceTime(): Promise<number> {
    const w = new BufferWriter();
    w.writeByte(CommandCode.GET_DEVICE_TIME);
    const resp = await this.sendCommand(w.toBytes());
    if (resp[0] !== ResponseCode.CURR_TIME) {
      throw new Error(`GET_DEVICE_TIME failed: code ${resp[0]}`);
    }
    const r = new BufferReader(resp.slice(1));
    return r.readUInt32LE();
  }

  // ─── Config commands ───────────────────────────────────────────

  async setTxPower(power: number): Promise<void> {
    const w = new BufferWriter();
    w.writeByte(CommandCode.SET_RADIO_TX_POWER);
    w.writeByte(power);
    const resp = await this.sendCommand(w.toBytes());
    if (resp[0] !== ResponseCode.OK) {
      throw new Error(`SET_TX_POWER failed: code ${resp[0]}`);
    }
  }

  async setRadioParams(freq: number, bw: number, sf: number, cr: number): Promise<void> {
    const w = new BufferWriter();
    w.writeByte(CommandCode.SET_RADIO_PARAMS);
    w.writeUInt32LE(Math.round(freq * 1000)); // freq in kHz
    w.writeUInt32LE(Math.round(bw * 1000));   // bw in Hz
    w.writeByte(sf);
    w.writeByte(cr);
    const resp = await this.sendCommand(w.toBytes());
    if (resp[0] !== ResponseCode.OK) {
      throw new Error(`SET_RADIO_PARAMS failed: code ${resp[0]}`);
    }
  }

  async setLocation(lat: number, lon: number): Promise<void> {
    const w = new BufferWriter();
    w.writeByte(CommandCode.SET_ADVERT_LATLON);
    w.writeInt32LE(Math.round(lat * 1e6));
    w.writeInt32LE(Math.round(lon * 1e6));
    const resp = await this.sendCommand(w.toBytes());
    if (resp[0] !== ResponseCode.OK) {
      throw new Error(`SET_LOCATION failed: code ${resp[0]}`);
    }
  }

  async setDevicePin(pin: number): Promise<void> {
    const w = new BufferWriter();
    w.writeByte(CommandCode.SET_DEVICE_PIN);
    w.writeUInt32LE(pin);
    const resp = await this.sendCommand(w.toBytes());
    if (resp[0] !== ResponseCode.OK) {
      throw new Error(`SET_DEVICE_PIN failed: code ${resp[0]}`);
    }
  }

  async getStats(): Promise<Uint8Array> {
    const w = new BufferWriter();
    w.writeByte(CommandCode.GET_STATS);
    return await this.sendCommand(w.toBytes());
  }

  async factoryReset(): Promise<void> {
    const w = new BufferWriter();
    w.writeByte(CommandCode.FACTORY_RESET);
    this.transport.send(w.toBytes());
  }

  /** Get all channels */
  async getAllChannels(): Promise<ChannelInfo[]> {
    const channels: ChannelInfo[] = [];
    const maxCh = this._deviceInfo?.maxChannels ?? 8;
    let consecutiveErrors = 0;
    for (let i = 0; i < maxCh; i++) {
      try {
        const ch = await this.getChannel(i);
        channels.push(ch);
        consecutiveErrors = 0;
      } catch {
        consecutiveErrors++;
        // Stop after 3 consecutive errors (likely hit device limit)
        if (consecutiveErrors >= 3) break;
      }
    }
    return channels;
  }

  // ─── Helpers ───────────────────────────────────────────────────

  /** Find a contact by name (case-insensitive partial match) */
  findContact(query: string): Contact | undefined {
    const q = query.toLowerCase();
    for (const c of this._contacts.values()) {
      if (c.name.toLowerCase() === q) return c;
    }
    for (const c of this._contacts.values()) {
      if (c.name.toLowerCase().includes(q)) return c;
    }
    return undefined;
  }

  /** Resolve sender key prefix to contact name */
  resolveContactName(keyPrefix: Uint8Array): string {
    if (keyPrefix.length === 0) return "broadcast";
    const prefixHex = toHex(keyPrefix);
    for (const c of this._contacts.values()) {
      if (c.publicKeyHex.startsWith(prefixHex)) return c.name;
    }
    return prefixHex.slice(0, 8);
  }
}
