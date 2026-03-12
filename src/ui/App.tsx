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
import { theme, snrColor, batteryColor, contactColor } from "./theme";
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

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pendingMsgsRef = useRef<ReceivedMessage[]>([]);
  const batchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seenMsgHashes = useRef<Set<string>>(new Set());

  const inputActive = ((mode === "chat" && chatInputFocused) || editingConfig !== null) && !confirmAction;

  // Initialize
  useEffect(() => {
    (async () => {
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
        await client.setDeviceTime();
        const contactList = await client.getContacts();
        setContacts(contactList);
        try {
          const batt = await client.getBattery();
          setBattery(batt.percentage);
          setBatteryMv(batt.millivolts);
        } catch {}
        try {
          const chs = await client.getAllChannels();
          setChannels(chs);
        } catch {}
        const msgs = await client.syncAllMessages();
        batchAddMessages(msgs);
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

    client.on("messages_waiting", async () => {
      try {
        const msgs = await client.syncAllMessages();
        if (msgs.length > 0) batchAddMessages(msgs);
      } catch {}
    });

    client.on("send_confirmed", () => {
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

    client.on("disconnected", () => setStatus("disconnected"));

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      if (batchTimerRef.current) clearTimeout(batchTimerRef.current);
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
          const sender = client.resolveContactName(m.senderKey);
          const chatMsg: ChatMessage = {
            id: ++msgIdCounter,
            timestamp: m.timestamp,
            sender,
            text: m.text,
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

      // Keep /to and /quit as power-user shortcuts
      if (value.startsWith("/")) {
        const parts = value.slice(1).split(/\s+/);
        const cmd = parts[0].toLowerCase();
        if (cmd === "quit" || cmd === "q") { client.disconnect(); exit(); return; }
        if (cmd === "to") {
          const target = parts.slice(1).join(" ");
          if (!target || target === "public" || target === "0") {
            setChatTarget("public"); setChatChannel(0);
            addSystemMessage("Target set to: PUBLIC CH0");
          } else if (target.match(/^ch?\d+$/i)) {
            const idx = parseInt(target.replace(/^ch?/i, ""), 10);
            setChatTarget(`ch${idx}`); setChatChannel(idx);
            addSystemMessage(`Target set to: CH${idx}`);
          } else {
            const contact = client.findContact(target);
            if (contact) {
              setChatTarget(contact.name);
              addSystemMessage(`Target set to DM: ${contact.name}`);
            } else {
              setError(`Contact not found: ${target}`);
            }
          }
          return;
        }
      }

      // Send message
      try {
        if (chatTarget === "public" || chatTarget.startsWith("ch")) {
          await client.sendChannelMessage(chatChannel, value);
          const ts = Math.floor(Date.now() / 1000);
          setMessages((prev) => [
            ...prev,
            { id: ++msgIdCounter, timestamp: ts, sender: "me", text: value, isSelf: true, channelIdx: chatChannel, status: "pending" },
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
      // Tab/Shift-Tab cycle through channels
      if (key.tab && key.shift) {
        const maxCh = channels.length > 0 ? channels.length - 1 : 0;
        const prev = chatChannel > 0 ? chatChannel - 1 : maxCh;
        setChatChannel(prev);
        setChatTarget(prev === 0 ? "public" : `ch${prev}`);
        return;
      }
      if (key.tab) {
        const maxCh = channels.length > 0 ? channels.length - 1 : 0;
        const next = chatChannel < maxCh ? chatChannel + 1 : 0;
        setChatChannel(next);
        setChatTarget(next === 0 ? "public" : `ch${next}`);
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
        <Text bold color={theme.fg.accent}>▓▓ MESHCORE</Text>
        <Text color={theme.fg.muted}> │ </Text>
        <Text color={status === "connected" ? theme.status.online : theme.status.offline}>
          {status === "connected" ? "● ONLINE" : "○ OFFLINE"}
        </Text>
        {selfInfo && (
          <>
            <Text color={theme.fg.muted}> │ </Text>
            <Text color={theme.fg.primary}>{selfInfo.name}</Text>
          </>
        )}
        {battery !== null && (
          <>
            <Text color={theme.fg.muted}> │ </Text>
            <Text color={batteryColor(battery)}>⚡{battery}%</Text>
          </>
        )}
        {contacts.length > 0 && (
          <>
            <Text color={theme.fg.muted}> │ </Text>
            <Text color={theme.fg.secondary}>{contacts.length} nodes</Text>
          </>
        )}
        <Box flexGrow={1} />
        <NavTab num="1" label="CHAT" active={mode === "chat"} />
        <Text> </Text>
        <NavTab num="2" label="NODES" active={mode === "nodes"} />
        <Text> </Text>
        <NavTab num="3" label="INFO" active={mode === "info"} />
        <Text> </Text>
        <NavTab num="4" label="CONF" active={mode === "config"} />
        <Text> </Text>
        <Text color={theme.fg.muted}>
          <Text color={theme.fg.secondary}>?</Text>
        </Text>
      </Box>

      {/* ═══ CONFIRMATION DIALOG ═══ */}
      {confirmAction && (
        <Box paddingX={1}>
          <Text color={theme.status.warning} bold>⚠ {confirmAction.label}</Text>
          <Text color={theme.fg.muted}> (y/n)</Text>
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
            <KeyHint k="Tab" desc="=next ch" />
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
}: {
  messages: ChatMessage[];
  height: number;
  scrollOffset: number;
  targetLabel: string;
  cols: number;
  channels: ChannelInfo[];
  chatChannel: number;
  chatTarget: string;
}) {
  const isDM = chatTarget !== "public" && !chatTarget.startsWith("ch");
  const sidebarWidth = 14;
  const msgAreaWidth = Math.max(20, cols - sidebarWidth - 4);
  const visibleCount = Math.max(1, height - 1);
  const endIdx = messages.length - scrollOffset;
  const startIdx = Math.max(0, endIdx - visibleCount);
  const visible = messages.slice(startIdx, Math.max(0, endIdx));

  return (
    <Box flexDirection="row" paddingX={1}>
      {/* Channel sidebar */}
      <Box flexDirection="column" width={sidebarWidth} borderStyle="single" borderColor={theme.border.normal} borderRight borderTop={false} borderBottom={false} borderLeft={false}>
        <Text color={theme.fg.secondary} bold>CHANNELS</Text>
        {(() => {
          // Always show ch0 as "public", then only named channels
          const visibleChannels = channels.length > 0
            ? channels.filter((ch) => ch.index === 0 || ch.name)
            : [];
          if (visibleChannels.length === 0) {
            const isActive = !isDM && chatChannel === 0;
            return <Text color={isActive ? theme.fg.accent : theme.fg.primary} bold={isActive}>{isActive ? "● " : "  "}public</Text>;
          }
          return visibleChannels.map((ch) => {
            const isActive = !isDM && chatChannel === ch.index;
            const label = ch.index === 0 ? "public" : `#${ch.name}`;
            return (
              <Box key={ch.index}>
                <Text color={isActive ? theme.fg.accent : theme.fg.primary} bold={isActive}>
                  {isActive ? "● " : "  "}{label.slice(0, sidebarWidth - 3)}
                </Text>
              </Box>
            );
          });
        })()}
        {isDM && (
          <Box marginTop={1}>
            <Text color={theme.fg.secondary} bold>DM</Text>
          </Box>
        )}
        {isDM && (
          <Box>
            <Text color={theme.fg.accent} bold>● {chatTarget.slice(0, sidebarWidth - 3)}</Text>
          </Box>
        )}
      </Box>

      {/* Messages area */}
      <Box flexDirection="column" flexGrow={1} paddingLeft={1}>

      {visible.length === 0 && (
        <Box flexDirection="column" paddingY={1}>
          <Text color={theme.fg.muted}>  No messages yet. Start typing to send a message.</Text>
          <Text color={theme.fg.muted}>  Go to Nodes (2) to select a contact, or type /to &lt;name&gt;</Text>
        </Box>
      )}
      {visible.map((m) => {
        const time = formatTime(m.timestamp);
        const chTag = m.channelIdx !== undefined ? `CH${m.channelIdx}` : "DM";
        const snrStr = m.snr !== undefined ? `${m.snr.toFixed(1)}dB` : "";

        const senderColor = m.isSelf
          ? theme.message.self
          : m.sender === "system"
            ? theme.message.system
            : theme.message.other;

        const timeCol = time.padEnd(9);
        const chanCol = chTag.padEnd(6);
        const senderCol = m.sender.slice(0, 13).padEnd(15);
        const fixedWidth = 9 + 6 + 15 + 7 + 4;
        const maxMsgLen = Math.max(10, msgAreaWidth - fixedWidth);
        const msgText = m.text.length > maxMsgLen ? m.text.slice(0, maxMsgLen - 1) + "…" : m.text;

        return (
          <Box key={m.id}>
            <Text color={theme.fg.muted}>{timeCol}</Text>
            <Text color={m.channelIdx !== undefined ? theme.message.channel : theme.fg.muted}>
              {chanCol}
            </Text>
            <Text color={senderColor} bold={!m.isSelf}>
              {senderCol}
            </Text>
            <Text color={theme.fg.primary}>{msgText}</Text>
            {snrStr && (
              <Text color={m.snr !== undefined ? snrColor(m.snr) : theme.fg.muted}>
                {" " + snrStr}
              </Text>
            )}
            {m.isSelf && m.status === "pending" && (
              <Text color={theme.fg.muted}> [···]</Text>
            )}
            {m.isSelf && m.status === "confirmed" && (
              <Text color={theme.status.online}> [✓]</Text>
            )}
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
          <HelpRow keys="Tab / Shift-Tab" desc="Next / previous channel" />
          <HelpRow keys="/to <target>" desc="Set DM target (name, public, ch#)" />
          <HelpRow keys="/quit" desc="Exit" />
        </Box>
      )}
      {mode === "nodes" && (
        <Box flexDirection="column">
          <HelpRow keys="j / k / ↑ / ↓" desc="Navigate node list" />
          <HelpRow keys="g / G" desc="Jump to top / bottom" />
          <HelpRow keys="d" desc="DM selected node" />
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
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  return `${h}:${m}:${s}`;
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
