import React, { useState, useEffect, useCallback, useRef } from "react";
import { Box, Text, useInput, useApp, useStdout } from "ink";
import TextInput from "ink-text-input";
import type {
  MeshCoreClient,
  Contact,
  ReceivedMessage,
  DeviceInfo,
  SelfInfo,
  ChannelInfo,
} from "../protocol/client";
import { toHex } from "../protocol/buffer";
import { theme, snrColor, batteryColor, contactColor, usernameColor } from "./theme";
import { getMessages, insertMessage, type DbMessage } from "../db";

interface ChatMessage {
  id: number;
  timestamp: number;
  sender: string;
  text: string;
  isSelf: boolean;
  channelIdx?: number;
  snr?: number;
  status?: "pending" | "confirmed";
}

type Mode = "chat" | "nodes" | "info" | "config";

let msgIdCounter = 0;

// Config field types for inline editing
interface ConfigField {
  key: string;
  label: string;
  value: string;
  type: "text" | "number" | "readonly" | "action";
  action?: () => Promise<void>;
}

interface AppProps {
  client: MeshCoreClient;
  deviceKey: string;
}

export default function App({ client, deviceKey }: AppProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const rows = stdout?.rows ?? 24;
  const cols = stdout?.columns ?? 80;

  const [mode, setMode] = useState<Mode>("chat");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [selfInfo, setSelfInfo] = useState<SelfInfo | null>(null);
  const [deviceInfo, setDeviceInfo] = useState<DeviceInfo | null>(null);
  const [channels, setChannels] = useState<ChannelInfo[]>([]);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState("connected");
  const [chatTarget, setChatTarget] = useState<string>("public");
  const [chatChannel, setChatChannel] = useState(0);
  const [battery, setBattery] = useState<number | null>(null);
  const [batteryMv, setBatteryMv] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [selectedNode, setSelectedNode] = useState(0);
  const [selectedConfig, setSelectedConfig] = useState(0);

  // Config inline editing state
  const [editingConfig, setEditingConfig] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");

  // Chat input focus state (modal input like meshtastic-cli)
  const [chatInputFocused, setChatInputFocused] = useState(false);
  // Context-aware help modal
  const [showHelp, setShowHelp] = useState(false);

  // Confirmation dialog state
  const [confirmAction, setConfirmAction] = useState<{ label: string; action: () => Promise<void> } | null>(null);
  const [responseModal, setResponseModal] = useState<{ title: string; lines: string[] } | null>(null);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pendingMsgsRef = useRef<ReceivedMessage[]>([]);
  const batchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seenMsgHashes = useRef<Set<string>>(new Set());

  const inputActive = ((mode === "chat" && chatInputFocused) || editingConfig !== null) && !confirmAction;

  // Initialize
  useEffect(() => {
    (async () => {
      addSystemMessage("Connected to device. Loading...");
      try {
        // Load persisted messages from SQLite
        const saved = getMessages(deviceKey);
        if (saved.length > 0) {
          const restored: ChatMessage[] = saved.map((m) => {
            const hash = `${m.timestamp}-${m.isSelf ? "self" : "msg"}-${m.text.slice(0, 30)}`;
            seenMsgHashes.current.add(hash);
            return {
              id: ++msgIdCounter,
              timestamp: m.timestamp,
              sender: m.sender,
              text: m.text,
              isSelf: m.isSelf,
              channelIdx: m.channelIdx,
              snr: m.snr,
            };
          });
          setMessages(restored);
        }

        setSelfInfo(client.selfInfo);
        try {
          const info = await client.deviceQuery();
          setDeviceInfo(info);
        } catch {}
        try { await client.setDeviceTime(); } catch {}
        await client.drainFrames(300);
        try {
          const contactList = await client.getContacts();
          setContacts(contactList);
          addSystemMessage(`Loaded ${contactList.length} contacts`);
        } catch (e: any) {
          addSystemMessage(`Failed to load contacts: ${e.message}`);
        }
        try {
          const batt = await client.getBattery();
          setBattery(batt.percentage);
          setBatteryMv(batt.millivolts);
        } catch {}
        await client.drainFrames(300);
        try {
          const chs = await client.getAllChannels();
          setChannels(chs);
          if (chs.length > 0) {
            addSystemMessage(`Loaded ${chs.length} channels: ${chs.map((c) => `ch${c.index}=${JSON.stringify(c.name)}`).join(", ")}`);
          } else {
            // Try single channel fetch for debugging
            try {
              const ch0 = await client.getChannel(0);
              addSystemMessage(`Single ch0 fetch OK: name=${JSON.stringify(ch0.name)}`);
            } catch (e2: any) {
              addSystemMessage(`Channels: getAllChannels returned 0. Single ch0 fetch also failed: ${e2.message}`);
            }
          }
        } catch (e: any) {
          addSystemMessage(`Failed to load channels: ${e.message}`);
        }
        try {
          const msgs = await client.syncAllMessages();
          batchAddMessages(msgs);
        } catch {}
        addSystemMessage("Ready.");
      } catch (e: any) {
        setError(e.message);
      }
    })();

    pollRef.current = setInterval(async () => {
      try {
        const msgs = await client.syncAllMessages();
        if (msgs.length > 0) batchAddMessages(msgs);
      } catch {}
    }, 2000);

    // Periodically refresh contacts and channels
    const refreshRef = setInterval(async () => {
      try { const cl = await client.getContacts(); setContacts(cl); } catch {}
      try { const chs = await client.getAllChannels(); setChannels(chs); } catch {}
    }, 30000);

    client.on("messages_waiting", async () => {
      addSystemMessage("Push: MSG_WAITING — syncing messages...");
      try {
        const msgs = await client.syncAllMessages();
        if (msgs.length > 0) {
          addSystemMessage(`Synced ${msgs.length} new message(s)`);
          batchAddMessages(msgs);
        }
      } catch (e: any) {
        addSystemMessage(`Sync failed: ${e.message}`);
      }
    });

    client.on("advert", (data: Uint8Array) => {
      addSystemMessage(`Push: ADVERT received (${data.length} bytes)`);
    });

    client.on("path_updated", (data: Uint8Array) => {
      addSystemMessage(`Push: PATH_UPDATED (${data.length} bytes)`);
    });

    client.on("send_confirmed", () => {
      addSystemMessage("Push: SEND_CONFIRMED — message delivered");
      // Mark the most recent pending self-message as confirmed
      setMessages((prev) => {
        const next = [...prev];
        for (let i = next.length - 1; i >= 0; i--) {
          if (next[i].isSelf && next[i].status === "pending") {
            next[i] = { ...next[i], status: "confirmed" };
            break;
          }
        }
        return next;
      });
    });

    client.on("trace_data", (data: Uint8Array) => {
      // Parse trace data: first 32 bytes = source key, rest = hop keys (32 bytes each)
      const hops: string[] = [];
      for (let i = 32; i + 32 <= data.length; i += 32) {
        const hopKey = toHex(data.slice(i, i + 32)).slice(0, 8);
        const contact = [...(client as any)._contacts.values()].find(
          (c: any) => toHex(c.publicKey).startsWith(hopKey)
        );
        hops.push(contact ? contact.name : hopKey + "...");
      }
      setResponseModal({
        title: "TRACEROUTE",
        lines: hops.length > 0
          ? hops.map((h, i) => `  ${i + 1}. ${h}`)
          : ["  Direct (no intermediate hops)"],
      });
    });

    client.on("telemetry_response", (data: Uint8Array) => {
      // Parse telemetry response
      const lines: string[] = [];
      if (data.length >= 4) {
        const battMv = (data[1] << 8) | data[0];
        if (battMv > 0) lines.push(`  Battery: ${battMv}mV`);
      }
      if (data.length >= 8) {
        const uptime = (data[5] << 16) | (data[4] << 8) | data[3];
        if (uptime > 0) {
          const hrs = Math.floor(uptime / 3600);
          const mins = Math.floor((uptime % 3600) / 60);
          lines.push(`  Uptime: ${hrs}h ${mins}m`);
        }
      }
      if (lines.length === 0) lines.push("  Response received (no data parsed)");
      setResponseModal({ title: "TELEMETRY", lines });
    });

    client.on("status_response", (data: Uint8Array) => {
      const lines: string[] = [];
      if (data.length >= 2) {
        const battPct = data[0];
        lines.push(`  Battery: ${battPct}%`);
      }
      if (lines.length === 0) lines.push("  Status response received");
      setResponseModal({ title: "STATUS", lines });
    });

    client.on("path_discovery_response", (data: Uint8Array) => {
      const hops: string[] = [];
      for (let i = 0; i + 32 <= data.length; i += 32) {
        const hopKey = toHex(data.slice(i, i + 32)).slice(0, 8);
        const contact = [...(client as any)._contacts.values()].find(
          (c: any) => toHex(c.publicKey).startsWith(hopKey)
        );
        hops.push(contact ? contact.name : hopKey + "...");
      }
      setResponseModal({
        title: "PATH DISCOVERY",
        lines: hops.length > 0
          ? hops.map((h, i) => `  ${i + 1}. ${h}`)
          : ["  Direct path"],
      });
    });

    client.on("push", ({ code, data }: { code: number; data: Uint8Array }) => {
      addSystemMessage(`Push: unknown code 0x${code.toString(16)} (${data.length} bytes)`);
    });

    client.on("contact_deleted", () => {
      addSystemMessage("Push: CONTACT_DELETED");
    });

    client.on("contacts_full", () => {
      addSystemMessage("Push: CONTACTS_FULL — contact table full");
    });

    client.on("disconnected", () => {
      setStatus("disconnected");
      addSystemMessage("Connection lost. Reconnecting...");
      // Auto-reconnect with backoff
      const tryReconnect = async (attempt = 0) => {
        const delay = Math.min(2000 * Math.pow(2, attempt), 30000);
        await new Promise((r) => setTimeout(r, delay));
        try {
          await client.connect();
          await client.appStart("mccli");
          setStatus("connected");
          addSystemMessage("Reconnected!");
          // Refresh state
          try { const cl = await client.getContacts(); setContacts(cl); } catch {}
          try { const chs = await client.getAllChannels(); setChannels(chs); } catch {}
          try { const msgs = await client.syncAllMessages(); if (msgs.length > 0) batchAddMessages(msgs); } catch {}
        } catch {
          addSystemMessage(`Reconnect attempt ${attempt + 1} failed, retrying...`);
          tryReconnect(attempt + 1);
        }
      };
      tryReconnect();
    });

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      if (batchTimerRef.current) clearTimeout(batchTimerRef.current);
      clearInterval(refreshRef);
    };
  }, []);

  const batchAddMessages = useCallback((newMsgs: ReceivedMessage[]) => {
    pendingMsgsRef.current.push(...newMsgs);
    if (batchTimerRef.current) clearTimeout(batchTimerRef.current);
    batchTimerRef.current = setTimeout(() => {
      const batch = pendingMsgsRef.current;
      pendingMsgsRef.current = [];
      if (batch.length === 0) return;

      setMessages((prev) => {
        const next = [...prev];
        for (const m of batch) {
          const hash = `${m.timestamp}-${m.type}-${m.text.slice(0, 30)}`;
          if (seenMsgHashes.current.has(hash)) continue;
          seenMsgHashes.current.add(hash);
          if (seenMsgHashes.current.size > 2000) {
            const arr = [...seenMsgHashes.current];
            seenMsgHashes.current = new Set(arr.slice(-1000));
          }
          let sender = client.resolveContactName(m.senderKey);
          let msgText = m.text;
          // Channel messages embed sender in text as "Name: message"
          if (sender === "broadcast" && m.type === "channel") {
            const colonIdx = m.text.indexOf(": ");
            if (colonIdx > 0 && colonIdx < 30) {
              sender = m.text.slice(0, colonIdx);
              msgText = m.text.slice(colonIdx + 2);
            }
          }
          const chatMsg: ChatMessage = {
            id: ++msgIdCounter,
            timestamp: m.timestamp,
            sender,
            text: msgText,
            isSelf: false,
            channelIdx: m.channelIdx,
            snr: m.snr,
          };
          next.push(chatMsg);
          insertMessage({
            timestamp: chatMsg.timestamp,
            sender: chatMsg.sender,
            text: chatMsg.text,
            isSelf: false,
            channelIdx: chatMsg.channelIdx,
            snr: chatMsg.snr,
            deviceKey,
          });
        }
        return next.slice(-500);
      });
      setScrollOffset(0);
    }, 100);
  }, []);

  const addSystemMessage = useCallback((text: string) => {
    setMessages((prev) => [
      ...prev,
      {
        id: ++msgIdCounter,
        timestamp: Math.floor(Date.now() / 1000),
        sender: "system",
        text,
        isSelf: false,
      },
    ]);
  }, []);

  // Build config items list
  const configItems: ConfigField[] = selfInfo
    ? [
        { key: "name", label: "Device Name", value: selfInfo.name, type: "text" },
        { key: "txpower", label: "TX Power (dBm)", value: String(selfInfo.txPower), type: "number" },
        { key: "freq", label: "Frequency", value: `${selfInfo.freq.toFixed(3)} MHz`, type: "readonly" },
        { key: "bw", label: "Bandwidth", value: `${selfInfo.bw.toFixed(1)} kHz`, type: "readonly" },
        { key: "sf", label: "Spreading Factor", value: `SF${selfInfo.sf}`, type: "readonly" },
        { key: "cr", label: "Coding Rate", value: `CR${selfInfo.cr}`, type: "readonly" },
        {
          key: "location",
          label: "Location",
          value: selfInfo.lat !== 0 ? `${selfInfo.lat.toFixed(6)}, ${selfInfo.lon.toFixed(6)}` : "not set",
          type: "readonly",
        },
        {
          key: "advert",
          label: "Send Advertisement",
          value: "press Enter",
          type: "action",
          action: async () => {
            setConfirmAction({
              label: "Send advertisement beacon?",
              action: async () => {
                await client.sendAdvert();
                addSystemMessage("Advertisement beacon sent");
              },
            });
          },
        },
        {
          key: "reboot",
          label: "Reboot Device",
          value: "press Enter",
          type: "action",
          action: async () => {
            setConfirmAction({
              label: "Reboot device? This will disconnect you.",
              action: async () => {
                await client.reboot();
                addSystemMessage("Device rebooting...");
              },
            });
          },
        },
      ]
    : [];

  // Add channel items to config (editable names)
  const allConfigItems: ConfigField[] = [
    ...configItems,
    { key: "ch_header", label: "── Channels ──", value: "", type: "readonly" },
    ...channels.map((ch) => ({
      key: `ch${ch.index}`,
      label: `CH${ch.index}`,
      value: ch.name || "(empty)",
      type: "text" as const,
    })),
  ];

  // Config edit handlers
  const startConfigEdit = (field: ConfigField) => {
    if (field.type === "action" && field.action) {
      field.action();
      return;
    }
    if (field.type === "readonly") return;
    setEditingConfig(field.key);
    setEditValue(field.value);
  };

  const commitConfigEdit = async () => {
    if (!editingConfig) return;
    const field = allConfigItems.find((f) => f.key === editingConfig);
    if (!field) { setEditingConfig(null); return; }

    try {
      if (editingConfig === "name") {
        await client.setAdvertName(editValue);
        addSystemMessage(`Name set to: ${editValue}`);
        // Refresh self info
        setSelfInfo((prev) => prev ? { ...prev, name: editValue } : prev);
      } else if (editingConfig === "txpower") {
        const power = parseInt(editValue, 10);
        if (!isNaN(power)) {
          await client.setTxPower(power);
          addSystemMessage(`TX power set to ${power} dBm`);
          setSelfInfo((prev) => prev ? { ...prev, txPower: power } : prev);
        }
      } else if (editingConfig.startsWith("ch")) {
        const idx = parseInt(editingConfig.slice(2), 10);
        const ch = channels.find((c) => c.index === idx);
        const secret = ch?.secret ?? new Uint8Array(16);
        await client.setChannel(idx, editValue, secret);
        addSystemMessage(`CH${idx} name set to: ${editValue}`);
        // Refresh channels
        try {
          const chs = await client.getAllChannels();
          setChannels(chs);
        } catch {}
      }
    } catch (e: any) {
      setError(e.message);
    }
    setEditingConfig(null);
  };

  const handleChatSubmit = useCallback(
    async (value: string) => {
      if (!value.trim()) return;
      setInput("");

      // Send message
      try {
        if (chatTarget === "public" || chatTarget.startsWith("ch")) {
          await client.sendChannelMessage(chatChannel, value);
          const ts = Math.floor(Date.now() / 1000);
          setMessages((prev) => [
            ...prev,
            { id: ++msgIdCounter, timestamp: ts, sender: "me", text: value, isSelf: true, channelIdx: chatChannel },
          ]);
          insertMessage({ timestamp: ts, sender: "me", text: value, isSelf: true, channelIdx: chatChannel, deviceKey });
        } else {
          const contact = client.findContact(chatTarget);
          if (contact) {
            await client.sendTextMessage(contact.publicKey, value);
            const ts = Math.floor(Date.now() / 1000);
            setMessages((prev) => [
              ...prev,
              { id: ++msgIdCounter, timestamp: ts, sender: "me", text: value, isSelf: true, status: "pending" },
            ]);
            insertMessage({ timestamp: ts, sender: "me", text: value, isSelf: true, deviceKey });
          } else {
            setError(`Contact not found: ${chatTarget}`);
          }
        }
      } catch (e: any) {
        setError(e.message);
      }
    },
    [chatTarget, chatChannel],
  );

  useInput((ch, key) => {
    if (error) setError(null);

    // ── RESPONSE MODAL ──
    if (responseModal) {
      setResponseModal(null);
      return;
    }

    // ── HELP MODAL ──
    if (showHelp) {
      // Any key dismisses the help modal
      setShowHelp(false);
      return;
    }

    // ── CONFIRMATION DIALOG ──
    if (confirmAction) {
      if (ch === "y" || ch === "Y") {
        const action = confirmAction.action;
        setConfirmAction(null);
        action().catch((e: any) => setError(e.message));
      } else {
        setConfirmAction(null);
      }
      return;
    }

    // ── CONFIG EDITING MODE ──
    if (editingConfig) {
      if (key.escape) { setEditingConfig(null); return; }
      // TextInput handles Enter/typing
      return;
    }

    // ── CHAT MODE (modal input) ──
    if (mode === "chat") {
      if (chatInputFocused) {
        if (key.escape) { setChatInputFocused(false); return; }
        return; // TextInput handles all other keys when focused
      }
      // Not focused — keyboard shortcuts work
      if (key.return) { setChatInputFocused(true); return; }
      // s toggles system channel
      if (ch === "s") {
        setChatTarget(chatTarget === "system" ? "public" : "system");
        if (chatTarget !== "system") setChatChannel(0);
        setScrollOffset(0);
        return;
      }
      // Tab/Shift-Tab or ,/. cycle through all sidebar targets
      if ((key.tab && key.shift) || ch === "," || key.tab || ch === ".") {
        const forward = key.tab || ch === ".";
        // Build ordered target list: channels → rooms → DMs → system
        type SidebarTarget = { target: string; channel: number };
        const targets: SidebarTarget[] = [];
        const chList = channels.filter((c) => c.index === 0 || c.name);
        for (const c of chList) {
          targets.push({ target: c.index === 0 ? "public" : `ch${c.index}`, channel: c.index });
        }
        if (targets.length === 0) targets.push({ target: "public", channel: 0 });
        for (const c of contacts.filter((c) => c.typeName === "room")) {
          targets.push({ target: c.name, channel: -1 });
        }
        for (const c of contacts.filter((c) => c.typeName === "client").slice(0, 5)) {
          targets.push({ target: c.name, channel: -1 });
        }
        targets.push({ target: "system", channel: -1 });

        const curIdx = targets.findIndex((t) => t.target === chatTarget);
        const nextIdx = forward
          ? (curIdx + 1) % targets.length
          : (curIdx - 1 + targets.length) % targets.length;
        const next = targets[nextIdx];
        setChatTarget(next.target);
        if (next.channel >= 0) setChatChannel(next.channel);
        setScrollOffset(0);
        return;
      }
      // [ and ] cycle top-level views
      if (ch === "]") { setMode("nodes"); return; }
      if (ch === "[") { setMode("config"); return; }
      if (ch === "2") { setMode("nodes"); return; }
      if (ch === "3") { setMode("info"); return; }
      if (ch === "4") { setMode("config"); return; }
      if (ch === "q") {
        setConfirmAction({ label: "Quit meshcore-tui?", action: async () => { client.disconnect(); exit(); } });
        return;
      }
      if (ch === "?") { setShowHelp(true); return; }
      return;
    }

    // ── NON-CHAT MODES ──
    if (key.escape) { setMode("chat"); return; }

    // [] cycle views
    const modeOrder: Mode[] = ["chat", "nodes", "info", "config"];
    if (ch === "]") {
      const idx = modeOrder.indexOf(mode);
      setMode(modeOrder[(idx + 1) % modeOrder.length]);
      return;
    }
    if (ch === "[") {
      const idx = modeOrder.indexOf(mode);
      setMode(modeOrder[(idx - 1 + modeOrder.length) % modeOrder.length]);
      return;
    }

    // Number keys and Enter
    if (key.return && mode !== "config") { setMode("chat"); return; }
    if (ch === "1") { setMode("chat"); return; }
    if (ch === "2") { setMode("nodes"); return; }
    if (ch === "3") { setMode("info"); return; }
    if (ch === "4") { setMode("config"); return; }
    if (ch === "q") {
      setConfirmAction({ label: "Quit meshcore-tui?", action: async () => { client.disconnect(); exit(); } });
      return;
    }
    if (ch === "?") { setShowHelp(true); return; }

    // ── NODES VIEW ──
    if (mode === "nodes") {
      if (ch === "j" || key.downArrow) {
        setSelectedNode((s) => Math.min(s + 1, contacts.length - 1));
      } else if (ch === "k" || key.upArrow) {
        setSelectedNode((s) => Math.max(0, s - 1));
      } else if (ch === "g") {
        setSelectedNode(0);
      } else if (ch === "G") {
        setSelectedNode(Math.max(0, contacts.length - 1));
      } else if (ch === "d" && contacts[selectedNode]) {
        // DM selected contact
        setChatTarget(contacts[selectedNode].name);
        addSystemMessage(`Target set to DM: ${contacts[selectedNode].name}`);
        setMode("chat");
      } else if (ch === "a") {
        // Send advertisement
        client.sendAdvert().then(() => addSystemMessage("Advertisement sent")).catch(() => {});
      } else if (ch === "r") {
        // Refresh contacts
        client.getContacts().then((cl) => {
          setContacts(cl);
          addSystemMessage(`Refreshed: ${cl.length} contacts`);
        }).catch(() => {});
      } else if (ch === "t" && contacts[selectedNode]) {
        // Traceroute
        const c = contacts[selectedNode];
        addSystemMessage(`Sending traceroute to ${c.name}...`);
        client.sendPathDiscovery(c.publicKey).then(() => {
          addSystemMessage(`Traceroute request sent to ${c.name}`);
        }).catch((e: any) => setError(`Traceroute failed: ${e.message}`));
      } else if (ch === "e" && contacts[selectedNode]) {
        // Telemetry/status request
        const c = contacts[selectedNode];
        addSystemMessage(`Requesting status from ${c.name}...`);
        client.sendStatusRequest(c.publicKey).then(() => {
          addSystemMessage(`Status request sent to ${c.name}`);
        }).catch((e: any) => setError(`Status request failed: ${e.message}`));
      } else if (ch === "x" && contacts[selectedNode]) {
        // Remove contact with confirmation
        const c = contacts[selectedNode];
        setConfirmAction({
          label: `Remove contact "${c.name}"?`,
          action: async () => {
            await client.removeContact(c.publicKey);
            addSystemMessage(`Removed: ${c.name}`);
            const cl = await client.getContacts();
            setContacts(cl);
            setSelectedNode((s) => Math.min(s, cl.length - 1));
          },
        });
      }
    }

    // ── CONFIG VIEW ──
    if (mode === "config") {
      if (ch === "j" || key.downArrow) {
        setSelectedConfig((s) => Math.min(s + 1, allConfigItems.length - 1));
      } else if (ch === "k" || key.upArrow) {
        setSelectedConfig((s) => Math.max(0, s - 1));
      } else if (key.return) {
        const item = allConfigItems[selectedConfig];
        if (item) startConfigEdit(item);
      }
    }
  });

  const targetLabel =
    chatTarget === "public"
      ? "PUBLIC CH0"
      : chatTarget.startsWith("ch")
        ? chatTarget.toUpperCase()
        : `DM:${chatTarget}`;

  return (
    <Box flexDirection="column" width={cols} height={rows}>
      {/* ═══ HEADER BAR ═══ */}
      <Box
        borderStyle="single"
        borderColor={theme.border.focused}
        paddingX={1}
      >
        <Text bold color={theme.fg.accent}>{cols >= 70 ? "▓▓ MESHCORE" : "▓▓"}</Text>
        <Text color={theme.fg.muted}> │ </Text>
        <Text color={status === "connected" ? theme.status.online : theme.status.offline}>
          {status === "connected" ? "●" : "○"}
        </Text>
        {selfInfo && cols >= 50 && (
          <>
            <Text color={theme.fg.muted}> │ </Text>
            <Text color={theme.fg.primary}>{selfInfo.name}</Text>
          </>
        )}
        {battery !== null && cols >= 60 && (
          <>
            <Text color={theme.fg.muted}> │ </Text>
            <Text color={batteryColor(battery)}>⚡{battery}%</Text>
          </>
        )}
        <Box flexGrow={1} />
        <NavTab num="1" label="CHAT" active={mode === "chat"} />
        <Text> </Text>
        <NavTab num="2" label="NODE" active={mode === "nodes"} />
        <Text> </Text>
        <NavTab num="3" label="INFO" active={mode === "info"} />
        <Text> </Text>
        <NavTab num="4" label="CONF" active={mode === "config"} />
        <Text> </Text>
        <Text color={theme.fg.secondary}>?</Text>
      </Box>

      {/* ═══ CONFIRMATION DIALOG (modal) ═══ */}
      {responseModal && (
        <Box
          position="absolute"
          flexDirection="column"
          width={cols}
          height={rows}
          justifyContent="center"
          alignItems="center"
        >
          <Box
            flexDirection="column"
            borderStyle="double"
            borderColor={theme.fg.accent}
            paddingX={3}
            paddingY={1}
            width={Math.min(50, cols - 4)}
          >
            <Text color={theme.fg.accent} bold>═══ {responseModal.title} ═══</Text>
            <Text> </Text>
            {responseModal.lines.map((line, i) => (
              <Text key={i} color={theme.fg.primary}>{line}</Text>
            ))}
            <Text> </Text>
            <Text color={theme.fg.muted}>Press any key to dismiss</Text>
          </Box>
        </Box>
      )}
      {confirmAction && (
        <Box
          position="absolute"
          flexDirection="column"
          width={cols}
          height={rows}
          justifyContent="center"
          alignItems="center"
        >
          <Box
            flexDirection="column"
            borderStyle="double"
            borderColor={theme.status.warning}
            paddingX={3}
            paddingY={1}
            width={Math.min(50, cols - 4)}
          >
            <Text color={theme.status.warning} bold>⚠ CONFIRM</Text>
            <Text> </Text>
            <Text color={theme.fg.primary}>{confirmAction.label}</Text>
            <Text> </Text>
            <Box>
              <Text color={theme.fg.secondary} bold>y</Text>
              <Text color={theme.fg.muted}> = yes   </Text>
              <Text color={theme.fg.secondary} bold>n</Text>
              <Text color={theme.fg.muted}> = cancel</Text>
            </Box>
          </Box>
        </Box>
      )}

      {/* ═══ ERROR BANNER ═══ */}
      {error && (
        <Box paddingX={1}>
          <Text color={theme.status.offline} bold>✗ {error}</Text>
        </Box>
      )}

      {/* ═══ MAIN CONTENT ═══ */}
      <Box flexGrow={1} flexDirection="column">
        {mode === "chat" && (
          <ChatView
            messages={messages}
            height={rows - 5}
            scrollOffset={scrollOffset}
            targetLabel={targetLabel}
            cols={cols}
            channels={channels}
            chatChannel={chatChannel}
            chatTarget={chatTarget}
            contacts={contacts}
          />
        )}
        {mode === "nodes" && (
          <NodesView
            contacts={contacts}
            height={rows - 5}
            selected={selectedNode}
            cols={cols}
          />
        )}
        {mode === "info" && (
          <InfoView
            selfInfo={selfInfo}
            deviceInfo={deviceInfo}
            battery={battery}
            batteryMv={batteryMv}
            contacts={contacts}
          />
        )}
        {mode === "config" && (
          <ConfigView
            items={allConfigItems}
            selected={selectedConfig}
            editingField={editingConfig}
            editValue={editValue}
            height={rows - 5}
          />
        )}
      </Box>

      {/* ═══ HELP MODAL OVERLAY ═══ */}
      {showHelp && (
        <Box
          position="absolute"
          flexDirection="column"
          width={cols}
          height={rows}
          justifyContent="center"
          alignItems="center"
        >
          <HelpModal mode={mode} cols={cols} rows={rows} />
        </Box>
      )}

      {/* ═══ INPUT BAR ═══ */}
      <Box
        borderStyle="single"
        borderColor={inputActive ? theme.border.focused : theme.border.normal}
        paddingX={1}
      >
        {editingConfig ? (
          <>
            <Text color={theme.fg.accent} bold>
              [{allConfigItems.find((f) => f.key === editingConfig)?.label ?? ""}]
            </Text>
            <Text color={theme.fg.accent}>{" ❯ "}</Text>
            <TextInput value={editValue} onChange={setEditValue} onSubmit={() => commitConfigEdit()} />
            <Text color={theme.fg.muted}> (Enter=save, Esc=cancel)</Text>
          </>
        ) : mode === "chat" && chatInputFocused ? (
          <>
            <Text color={theme.fg.accent} bold>[{targetLabel}]</Text>
            <Text color={theme.fg.accent}>{" ❯ "}</Text>
            <TextInput value={input} onChange={setInput} onSubmit={handleChatSubmit} />
          </>
        ) : mode === "chat" ? (
          <>
            <Text color={theme.fg.muted}>[{targetLabel}] </Text>
            <KeyHint k="Enter" desc="=type" />
            <Text color={theme.fg.muted}>│ </Text>
            <KeyHint k="./," desc="=ch ↔" />
            <Text color={theme.fg.muted}>│ </Text>
            <KeyHint k="]/[" desc="=views" />
            <Text color={theme.fg.muted}>│ </Text>
            <KeyHint k="?" desc="=help" />
          </>
        ) : (
          <>
            {mode === "nodes" ? (
              <Text>
                <KeyHint k="j/k" desc=" nav" />
                <Text color={theme.fg.muted}>│ </Text>
                <KeyHint k="d" desc="=DM" />
                <Text color={theme.fg.muted}>│ </Text>
                <KeyHint k="a" desc="=advert" />
                <Text color={theme.fg.muted}>│ </Text>
                <KeyHint k="r" desc="=refresh" />
                <Text color={theme.fg.muted}>│ </Text>
                <KeyHint k="x" desc="=remove" />
                <Text color={theme.fg.muted}>│ </Text>
                <KeyHint k="Enter" desc="=chat" />
              </Text>
            ) : mode === "config" ? (
              <Text>
                <KeyHint k="j/k" desc=" nav" />
                <Text color={theme.fg.muted}>│ </Text>
                <KeyHint k="Enter" desc="=edit" />
                <Text color={theme.fg.muted}>│ </Text>
                <KeyHint k="Esc" desc="=chat" />
              </Text>
            ) : (
              <Text>
                <KeyHint k="Enter/Esc" desc="=chat" />
                <Text color={theme.fg.muted}>│ </Text>
                <KeyHint k="1-4" desc="=views" />
                <Text color={theme.fg.muted}>│ </Text>
                <KeyHint k="?" desc="=help" />
              </Text>
            )}
          </>
        )}
      </Box>
    </Box>
  );
}

// ─── Sub-components ──────────────────────────────────────────────

function NavTab({ num, label, active }: { num: string; label: string; active: boolean }) {
  return (
    <Text>
      <Text color={active ? theme.fg.accent : theme.fg.muted}>{num}</Text>
      <Text color={active ? theme.fg.accent : theme.fg.muted}>⟩</Text>
      <Text bold={active} color={active ? theme.fg.accent : theme.fg.secondary}>{label}</Text>
    </Text>
  );
}

/** Render keybinding hint: key in accent, description in muted */
function KeyHint({ k, desc }: { k: string; desc: string }) {
  return (
    <Text>
      <Text color={theme.fg.secondary}>{k}</Text>
      <Text color={theme.fg.muted}>{desc} </Text>
    </Text>
  );
}

// ─── CHAT VIEW ───────────────────────────────────────────────────

function ChatView({
  messages,
  height,
  scrollOffset,
  targetLabel,
  cols,
  channels,
  chatChannel,
  chatTarget,
  contacts,
}: {
  messages: ChatMessage[];
  height: number;
  scrollOffset: number;
  targetLabel: string;
  cols: number;
  channels: ChannelInfo[];
  chatChannel: number;
  chatTarget: string;
  contacts: Contact[];
}) {
  const isDM = chatTarget !== "public" && !chatTarget.startsWith("ch");
  const isSystem = chatTarget === "system";

  // Filter messages based on active target
  const allMessages = messages || [];
  const filtered = isSystem
    ? allMessages.filter((m) => m.sender === "system")
    : isDM
      ? allMessages.filter((m) => m.sender !== "system" && m.channelIdx === undefined)
      : allMessages.filter((m) => m.sender !== "system" && (m.channelIdx ?? 0) === chatChannel);

  // Responsive breakpoints
  const wide = cols >= 80;
  const medium = cols >= 50 && cols < 80;
  // narrow = cols < 50

  const sidebarWidth = 14;
  const msgAreaWidth = wide ? Math.max(20, cols - sidebarWidth - 4) : Math.max(20, cols - 4);
  const headerLines = wide ? 0 : 1;
  const visibleCount = Math.max(1, height - headerLines - 1);
  const safeOffset = filtered.length > 0 ? Math.min(scrollOffset, filtered.length - 1) : 0;
  const endIdx = filtered.length - safeOffset;
  const startIdx = Math.max(0, endIdx - visibleCount);
  const visible = endIdx > 0 ? filtered.slice(startIdx, endIdx) : [];

  // Channel name for compact header
  const activeChannelName = isSystem
    ? "system"
    : isDM
      ? `DM:${chatTarget}`
      : channels.find((c) => c.index === chatChannel)?.name || (chatChannel === 0 ? "public" : `ch${chatChannel}`);

  // Get visible channels for sidebar
  const visibleChannels = channels.length > 0
    ? channels.filter((ch) => ch.index === 0 || ch.name)
    : [];

  return (
    <Box flexDirection="row" paddingX={1}>
      {/* Channel sidebar — wide only */}
      {wide && (
        <Box flexDirection="column" width={sidebarWidth} borderStyle="single" borderColor={theme.border.normal} borderRight borderTop={false} borderBottom={false} borderLeft={false}>
          <Text color={theme.fg.secondary} bold>CHANNELS</Text>
          {visibleChannels.length === 0 ? (
            <Text color={!isDM && chatChannel === 0 ? theme.fg.accent : theme.fg.primary} bold={!isDM && chatChannel === 0}>
              {!isDM && chatChannel === 0 ? "● " : "  "}public
            </Text>
          ) : (
            visibleChannels.map((ch) => {
              const isActive = !isDM && chatChannel === ch.index;
              const label = ch.index === 0 ? "public" : `#${ch.name}`;
              return (
                <Box key={ch.index}>
                  <Text color={isActive ? theme.fg.accent : theme.fg.primary} bold={isActive}>
                    {isActive ? "● " : "  "}{label.slice(0, sidebarWidth - 3)}
                  </Text>
                </Box>
              );
            })
          )}
          {/* Rooms */}
          {contacts.filter((c) => c.typeName === "room").length > 0 && (
            <>
              <Box marginTop={1}>
                <Text color={theme.fg.secondary} bold>ROOMS</Text>
              </Box>
              {contacts.filter((c) => c.typeName === "room").map((c) => {
                const isActive = isDM && chatTarget === c.name;
                return (
                  <Box key={c.publicKeyHex}>
                    <Text color={isActive ? theme.fg.accent : theme.contact.room} bold={isActive}>
                      {isActive ? "● " : "  "}{c.name.slice(0, sidebarWidth - 3)}
                    </Text>
                  </Box>
                );
              })}
            </>
          )}
          {/* DMs — show contacts we've messaged or that are clients */}
          {contacts.filter((c) => c.typeName === "client").length > 0 && (
            <>
              <Box marginTop={1}>
                <Text color={theme.fg.secondary} bold>DMs</Text>
              </Box>
              {contacts.filter((c) => c.typeName === "client").slice(0, 5).map((c) => {
                const isActive = isDM && chatTarget === c.name;
                return (
                  <Box key={c.publicKeyHex}>
                    <Text color={isActive ? theme.fg.accent : theme.contact.client} bold={isActive}>
                      {isActive ? "● " : "  "}{c.name.slice(0, sidebarWidth - 3)}
                    </Text>
                  </Box>
                );
              })}
            </>
          )}
          <Box marginTop={1}>
            <Text color={isSystem ? theme.fg.accent : theme.fg.muted} bold={isSystem}>
              {isSystem ? "● " : "  "}system
            </Text>
          </Box>
        </Box>
      )}

      {/* Messages area */}
      <Box flexDirection="column" flexGrow={1} paddingLeft={wide ? 1 : 0}>

      {/* Compact channel header — medium/narrow */}
      {!wide && (
        <Box>
          <Text color={theme.fg.accent} bold>● {activeChannelName}</Text>
          <Text color={theme.fg.muted}> ({filtered.length} msgs)</Text>
        </Box>
      )}

      {visible.length === 0 && (
        <Box flexDirection="column" paddingY={1}>
          <Text color={theme.fg.muted}>  No messages yet. Press Enter to type.</Text>
        </Box>
      )}
      {visible.map((m) => {
        const time = formatTime(m.timestamp);
        const snrStr = m.snr !== undefined ? `${m.snr.toFixed(1)}dB` : "";

        const senderColor = m.isSelf
          ? theme.message.self
          : m.sender === "system"
            ? theme.message.system
            : usernameColor(m.sender);

        // Split reply from main text (reply follows after " ↩ " or similar patterns)
        let mainText = m.text;
        let replyText = "";
        const replyIdx = m.text.indexOf(" ↩ ");
        if (replyIdx > 0) {
          mainText = m.text.slice(0, replyIdx);
          replyText = m.text.slice(replyIdx);
        }

        // Responsive message layout
        if (wide || medium) {
          const timeCol = time.padEnd(9);
          const senderMax = wide ? 13 : 8;
          const senderPad = wide ? 15 : 10;
          const senderCol = m.sender.slice(0, senderMax).padEnd(senderPad);

          return (
            <Box key={m.id}>
              <Text color={theme.fg.muted}>{timeCol}</Text>
              <Text color={senderColor} bold={!m.isSelf}>{senderCol}</Text>
              <Text color={theme.fg.primary}>{mainText}</Text>
              {replyText && <Text color={theme.fg.muted}>{replyText}</Text>}
              {m.isSelf && m.status === "pending" && <Text color={theme.fg.muted}> [···]</Text>}
              {m.isSelf && m.status === "confirmed" && <Text color={theme.status.online}> [✓]</Text>}
            </Box>
          );
        }

        // Narrow: minimal layout
        const senderShort = m.sender.slice(0, 6);
        return (
          <Box key={m.id}>
            <Text color={senderColor} bold={!m.isSelf}>{senderShort} </Text>
            <Text color={theme.fg.primary}>{mainText}</Text>
            {replyText && <Text color={theme.fg.muted}>{replyText}</Text>}
            {m.isSelf && m.status === "pending" && <Text color={theme.fg.muted}> ···</Text>}
            {m.isSelf && m.status === "confirmed" && <Text color={theme.status.online}> ✓</Text>}
          </Box>
        );
      })}
      </Box>
    </Box>
  );
}

// ─── NODES VIEW ─────────────────────────────────────────────────

function NodesView({
  contacts,
  height,
  selected,
  cols,
}: {
  contacts: Contact[];
  height: number;
  selected: number;
  cols: number;
}) {
  const inspectorHeight = 8;
  const listHeight = Math.max(1, height - inspectorHeight - 3);
  const startIdx = Math.max(
    0,
    Math.min(
      selected - Math.floor(listHeight / 2),
      contacts.length - listHeight,
    ),
  );
  const visible = contacts.slice(startIdx, startIdx + listHeight);
  const selectedContact = contacts[selected];

  return (
    <Box flexDirection="column" height={height}>
      {/* Node list */}
      <Box flexDirection="column" paddingX={1} flexGrow={1}>
        <Box>
          <Text color={theme.fg.secondary} bold>
            {"  "}{"NAME".padEnd(20)}{"TYPE".padEnd(10)}{"HOPS".padEnd(6)}{"KEY".padEnd(10)}{"LAST SEEN"}
          </Text>
        </Box>
        {contacts.length === 0 && (
          <Box paddingY={1} flexDirection="column">
            <Text color={theme.fg.muted}>  No nodes discovered yet.</Text>
            <Text color={theme.fg.muted}>  Press 'a' to send an advertisement beacon.</Text>
          </Box>
        )}
        {visible.map((c, i) => {
          const actualIdx = startIdx + i;
          const isSelected = actualIdx === selected;
          const lastSeen = c.lastAdvert > 0 ? timeSince(c.lastAdvert) : "never";
          const typeColor = contactColor(c.typeName);
          const prefix = isSelected ? "▶ " : "  ";

          return (
            <Box key={c.publicKeyHex}>
              <Text
                backgroundColor={isSelected ? theme.bg.selected : undefined}
                color={isSelected ? theme.fg.accent : theme.fg.primary}
              >
                {prefix}{c.name.slice(0, 18).padEnd(20)}
              </Text>
              <Text backgroundColor={isSelected ? theme.bg.selected : undefined} color={typeColor}>
                {c.typeName.padEnd(10)}
              </Text>
              <Text
                backgroundColor={isSelected ? theme.bg.selected : undefined}
                color={c.pathLen <= 1 ? theme.status.online : c.pathLen <= 3 ? theme.fg.accent : theme.fg.secondary}
              >
                {String(c.pathLen).padEnd(6)}
              </Text>
              <Text backgroundColor={isSelected ? theme.bg.selected : undefined} color={theme.fg.muted}>
                {c.publicKeyHex.slice(0, 8).padEnd(10)}
              </Text>
              <Text backgroundColor={isSelected ? theme.bg.selected : undefined} color={theme.fg.muted}>
                {lastSeen}
              </Text>
            </Box>
          );
        })}
      </Box>

      {/* Node inspector */}
      <Box
        borderStyle="single"
        borderColor={theme.border.normal}
        borderTop
        borderBottom={false}
        borderLeft={false}
        borderRight={false}
      />
      <Box flexDirection="column" paddingX={1} height={inspectorHeight}>
        {selectedContact ? (
          <>
            <Box>
              <Text color={theme.fg.accent} bold>{selectedContact.name}</Text>
              <Text color={theme.fg.muted}> │ </Text>
              <Text color={contactColor(selectedContact.typeName)}>{selectedContact.typeName}</Text>
              <Text color={theme.fg.muted}> │ </Text>
              <Text color={theme.fg.secondary}>key: {selectedContact.publicKeyHex.slice(0, 16)}...</Text>
            </Box>
            <Box>
              <Text color={theme.fg.muted}>Hops: </Text>
              <Text color={selectedContact.pathLen <= 1 ? theme.status.online : theme.fg.primary}>
                {selectedContact.pathLen === 0 ? "Direct" : String(selectedContact.pathLen)}
              </Text>
              <Text color={theme.fg.muted}>  Last seen: </Text>
              <Text color={theme.fg.secondary}>
                {selectedContact.lastAdvert > 0 ? timeSince(selectedContact.lastAdvert) : "never"}
              </Text>
            </Box>
            {selectedContact.lat !== 0 && (
              <Box>
                <Text color={theme.fg.muted}>Position: </Text>
                <Text color="#00bfff">
                  {selectedContact.lat.toFixed(6)}, {selectedContact.lon.toFixed(6)}
                </Text>
              </Box>
            )}
            <Box>
              <Text color={theme.fg.muted}>
                Full key: {selectedContact.publicKeyHex}
              </Text>
            </Box>
          </>
        ) : (
          <Text color={theme.fg.muted}>No node selected</Text>
        )}
      </Box>
    </Box>
  );
}

// ─── INFO VIEW ───────────────────────────────────────────────────

function InfoView({
  selfInfo,
  deviceInfo,
  battery,
  batteryMv,
  contacts,
}: {
  selfInfo: SelfInfo | null;
  deviceInfo: DeviceInfo | null;
  battery: number | null;
  batteryMv: number | null;
  contacts: Contact[];
}) {
  if (!selfInfo)
    return (
      <Box paddingX={1}>
        <Text color={theme.fg.muted}>Loading device info...</Text>
      </Box>
    );

  const repeaters = contacts.filter((c) => c.typeName === "repeater").length;
  const clients = contacts.filter((c) => c.typeName === "client").length;
  const rooms = contacts.filter((c) => c.typeName === "room").length;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={0}>
        <Text color={theme.fg.accent} bold>═══ DEVICE INFO ═══</Text>
      </Box>

      <Box flexDirection="column">
        <InfoRow label="Name" value={selfInfo.name} valueColor={theme.fg.accent} />
        {deviceInfo && (
          <>
            <InfoRow label="Firmware" value={`v${deviceInfo.firmwareVer} (${deviceInfo.firmwareVersion})`} />
            <InfoRow label="Build" value={deviceInfo.buildDate} />
            <InfoRow label="Model" value={deviceInfo.model} />
            <InfoRow label="Max Contacts" value={String(deviceInfo.maxContacts)} />
            <InfoRow label="Max Channels" value={String(deviceInfo.maxChannels)} />
          </>
        )}
        <Text color={theme.border.normal}>{"  " + "─".repeat(45)}</Text>
        <InfoRow label="Frequency" value={`${selfInfo.freq.toFixed(3)} MHz`} valueColor={theme.message.channel} />
        <InfoRow label="Bandwidth" value={`${selfInfo.bw.toFixed(1)} kHz`} />
        <InfoRow label="SF / CR" value={`SF${selfInfo.sf} / CR${selfInfo.cr}`} />
        <InfoRow label="TX Power" value={`${selfInfo.txPower} / ${selfInfo.maxTxPower} dBm`} />
        {selfInfo.lat !== 0 && (
          <InfoRow label="Location" value={`${selfInfo.lat.toFixed(6)}, ${selfInfo.lon.toFixed(6)}`} valueColor="#00bfff" />
        )}
        <Text color={theme.border.normal}>{"  " + "─".repeat(45)}</Text>
        <InfoRow label="Public Key" value={toHex(selfInfo.publicKey).slice(0, 16) + "..."} valueColor={theme.fg.muted} />
        {battery !== null && (
          <InfoRow
            label="Battery"
            value={`${battery}%${batteryMv ? ` (${batteryMv}mV)` : ""}`}
            valueColor={batteryColor(battery)}
          />
        )}
        <InfoRow
          label="Contacts"
          value={`${contacts.length} total (${clients}C ${repeaters}R ${rooms}Rm)`}
        />
      </Box>
    </Box>
  );
}

function InfoRow({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <Box>
      <Text color={theme.fg.secondary}>{"  " + label.padEnd(14)}</Text>
      <Text color={valueColor ?? theme.fg.primary}>{value}</Text>
    </Box>
  );
}

// ─── CONFIG VIEW ─────────────────────────────────────────────────

function ConfigView({
  items,
  selected,
  editingField,
  editValue,
  height,
}: {
  items: ConfigField[];
  selected: number;
  editingField: string | null;
  editValue: string;
  height: number;
}) {
  if (items.length === 0)
    return (
      <Box paddingX={1}>
        <Text color={theme.fg.muted}>Loading config...</Text>
      </Box>
    );

  const contentHeight = Math.max(1, height - 3);
  let startIndex = 0;
  if (items.length > contentHeight) {
    const halfView = Math.floor(contentHeight / 2);
    startIndex = Math.max(0, Math.min(selected - halfView, items.length - contentHeight));
  }
  const visible = items.slice(startIndex, startIndex + contentHeight);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box>
        <Text color={theme.fg.accent} bold>CONFIG</Text>
        <Text color={theme.fg.muted}> — </Text>
        <KeyHint k="j/k" desc=" nav" />
        <KeyHint k="Enter" desc=" edit/activate" />
      </Box>

      {visible.map((item, i) => {
        const globalIndex = startIndex + i;
        const isSelected = globalIndex === selected;
        const isEditing = editingField === item.key;

        return (
          <Box key={item.key} backgroundColor={isSelected && !isEditing ? theme.bg.selected : undefined}>
            <Text color={isSelected ? theme.fg.accent : theme.fg.muted}>
              {isSelected ? "> " : "  "}
            </Text>
            <Text color={theme.fg.secondary}>{item.label.padEnd(20)}</Text>
            {isEditing ? (
              <>
                <Text color={theme.fg.accent}>{editValue}</Text>
                <Text color={theme.fg.accent}>█</Text>
                <Text color={theme.fg.muted}> (Enter=save, Esc=cancel)</Text>
              </>
            ) : (
              <>
                <Text color={item.type === "readonly" ? theme.fg.muted : theme.fg.primary}>
                  {item.value}
                </Text>
                {isSelected && item.type === "text" && (
                  <Text color={theme.fg.muted}> [Enter] edit</Text>
                )}
                {isSelected && item.type === "number" && (
                  <Text color={theme.fg.muted}> [Enter] edit</Text>
                )}
                {isSelected && item.type === "action" && (
                  <Text color={theme.fg.muted}> [Enter] activate</Text>
                )}
              </>
            )}
          </Box>
        );
      })}
    </Box>
  );
}

// ─── HELP MODAL ──────────────────────────────────────────────────

function HelpModal({ mode, cols, rows }: { mode: Mode; cols: number; rows: number }) {
  const w = Math.min(56, cols - 4);
  const sep = "─".repeat(w - 4);

  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor={theme.fg.accent}
      paddingX={1}
      paddingY={1}
      width={w}
    >
      <Text color={theme.fg.accent} bold>
        {mode === "chat" ? "CHAT HELP" : mode === "nodes" ? "NODES HELP" : mode === "info" ? "INFO HELP" : "CONFIG HELP"}
      </Text>
      <Text color={theme.border.normal}>{sep}</Text>

      {/* Context-specific help */}
      {mode === "chat" && (
        <Box flexDirection="column">
          <HelpRow keys="Enter" desc="Focus input to type" />
          <HelpRow keys="Esc" desc="Unfocus input" />
          <HelpRow keys="Tab/. / Shift-Tab/," desc="Next / previous channel" />
          <HelpRow keys="./," desc="Next / previous sidebar target" />
        </Box>
      )}
      {mode === "nodes" && (
        <Box flexDirection="column">
          <HelpRow keys="j / k / ↑ / ↓" desc="Navigate node list" />
          <HelpRow keys="g / G" desc="Jump to top / bottom" />
          <HelpRow keys="d" desc="DM selected node" />
          <HelpRow keys="t" desc="Traceroute to selected node" />
          <HelpRow keys="e" desc="Request telemetry/status" />
          <HelpRow keys="a" desc="Send advertisement beacon" />
          <HelpRow keys="r" desc="Refresh contacts from device" />
          <HelpRow keys="x" desc="Remove selected contact" />
        </Box>
      )}
      {mode === "info" && (
        <Box flexDirection="column">
          <Text color={theme.fg.muted}>  Device info is read-only.</Text>
          <Text color={theme.fg.muted}>  Go to Config (4) to change settings.</Text>
        </Box>
      )}
      {mode === "config" && (
        <Box flexDirection="column">
          <HelpRow keys="j / k" desc="Navigate config items" />
          <HelpRow keys="Enter" desc="Edit field or activate action" />
          <HelpRow keys="Esc" desc="Cancel edit / return to chat" />
        </Box>
      )}

      <Text color={theme.border.normal}>{sep}</Text>
      <Box flexDirection="column">
        <Text color={theme.fg.secondary} bold>Global</Text>
        <HelpRow keys="1 / 2 / 3 / 4" desc="Chat / Nodes / Info / Config" />
        <HelpRow keys="] / [" desc="Next / previous view" />
        <HelpRow keys="Esc" desc="Return to chat" />
        <HelpRow keys="?" desc="Toggle this help" />
        <HelpRow keys="Ctrl+C" desc="Quit" />
      </Box>

      <Box marginTop={1}>
        <Text color={theme.fg.muted}>Press any key to close</Text>
      </Box>
    </Box>
  );
}

function HelpRow({ keys, desc }: { keys: string; desc: string }) {
  return (
    <Box>
      <Text color={theme.fg.secondary}> {keys.padEnd(20)}</Text>
      <Text color={theme.fg.primary}>{desc}</Text>
    </Box>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────

function formatTime(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toLocaleTimeString(undefined, { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function timeSince(unixTimestamp: number): string {
  const now = Math.floor(Date.now() / 1000);
  const diff = now - unixTimestamp;
  if (diff < 0) return "now";
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}
