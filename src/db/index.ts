// SQLite message database for meshcore-tui
// Persists messages across sessions using bun:sqlite

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface DbMessage {
  id?: number;
  timestamp: number;
  sender: string;
  text: string;
  isSelf: boolean;
  channelIdx?: number;
  snr?: number;
  deviceKey: string; // identifies which device this message belongs to
}

let db: Database | null = null;

function getDbPath(): string {
  const dir = join(homedir(), ".meshcore-tui");
  mkdirSync(dir, { recursive: true });
  return join(dir, "messages.db");
}

export function openDb(): Database {
  if (db) return db;
  db = new Database(getDbPath());
  db.run("PRAGMA journal_mode=WAL");
  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      sender TEXT NOT NULL,
      text TEXT NOT NULL,
      is_self INTEGER NOT NULL DEFAULT 0,
      channel_idx INTEGER,
      snr REAL,
      device_key TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_messages_device_key ON messages(device_key)
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(device_key, timestamp)
  `);
  return db;
}

export function clearDb(): void {
  closeDb();
  const path = getDbPath();
  try { require("node:fs").unlinkSync(path); } catch {}
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

export function insertMessage(msg: DbMessage): void {
  const d = openDb();
  d.run(
    `INSERT INTO messages (timestamp, sender, text, is_self, channel_idx, snr, device_key)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [msg.timestamp, msg.sender, msg.text, msg.isSelf ? 1 : 0, msg.channelIdx ?? null, msg.snr ?? null, msg.deviceKey],
  );
}

export function getMessages(deviceKey: string, limit = 500): DbMessage[] {
  const d = openDb();
  const rows = d
    .query(
      `SELECT id, timestamp, sender, text, is_self, channel_idx, snr, device_key
       FROM messages WHERE device_key = ? ORDER BY timestamp DESC LIMIT ?`,
    )
    .all(deviceKey, limit) as any[];

  return rows.reverse().map((r) => ({
    id: r.id,
    timestamp: r.timestamp,
    sender: r.sender,
    text: r.text,
    isSelf: r.is_self === 1,
    channelIdx: r.channel_idx ?? undefined,
    snr: r.snr ?? undefined,
    deviceKey: r.device_key,
  }));
}

/** Generate a device key from host:port for message isolation */
export function deviceKey(host: string, port: number): string {
  return `${host}:${port}`;
}
