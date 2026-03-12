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

interface ChatMessage {
  id: number;
  timestamp: number;
  sender: string;
  text: string;
  isSelf: boolean;
  channelIdx?: number;
  snr?: number;
}

type Mode = "chat" | "contacts" | "info" | "config" | "help";

let msgIdCounter = 0;

interface AppProps {
  client: MeshCoreClient;
}

export default function App({ client }: AppProps) {
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
  const [selectedContact, setSelectedContact] = useState(0);
  const [selectedConfig, setSelectedConfig] = useState(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pendingMsgsRef = useRef<ReceivedMessage[]>([]);
  const batchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seenMsgHashes = useRef<Set<string>>(new Set());

  // In chat mode, input is always focused. In other modes, it's not.
  const inputActive = mode === "chat";

  // Initialize
  useEffect(() => {
    (async () => {
      try {
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

    client.on("disconnected", () => setStatus("disconnected"));

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      if (batchTimerRef.current) clearTimeout(batchTimerRef.current);
    };
  }, []);

  /** Batch incoming messages with 100ms debounce to reduce re-renders */
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
          next.push({
            id: ++msgIdCounter,
            timestamp: m.timestamp,
            sender,
            text: m.text,
            isSelf: false,
            channelIdx: m.channelIdx,
            snr: m.snr,
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

  const handleSubmit = useCallback(
    async (value: string) => {
      if (!value.trim()) return;
      setInput("");

      if (value.startsWith("/")) {
        const parts = value.slice(1).split(/\s+/);
        const cmd = parts[0].toLowerCase();

        switch (cmd) {
          case "quit":
          case "q":
            client.disconnect();
            exit();
            return;
          case "contacts":
          case "c":
            setMode("contacts");
            return;
          case "chat":
            setMode("chat");
            return;
          case "info":
          case "i":
            setMode("info");
            return;
          case "config":
            setMode("config");
            return;
          case "to": {
            const target = parts.slice(1).join(" ");
            if (!target || target === "public" || target === "0") {
              setChatTarget("public");
              setChatChannel(0);
              addSystemMessage("Target set to: PUBLIC CH0");
            } else if (target.match(/^ch?\d+$/i)) {
              const idx = parseInt(target.replace(/^ch?/i, ""), 10);
              setChatTarget(`ch${idx}`);
              setChatChannel(idx);
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
          case "advert":
            await client.sendAdvert();
            addSystemMessage("Advertisement beacon sent (flood)");
            return;
          case "name":
            if (parts[1]) {
              const newName = parts.slice(1).join(" ");
              await client.setAdvertName(newName);
              addSystemMessage(`Name set to: ${newName}`);
            }
            return;
          case "refresh":
          case "r": {
            const cl = await client.getContacts();
            setContacts(cl);
            addSystemMessage(`Refreshed: ${cl.length} contacts loaded`);
            return;
          }
          case "power":
          case "txpower": {
            const power = parseInt(parts[1], 10);
            if (!isNaN(power)) {
              await client.setTxPower(power);
              addSystemMessage(`TX power set to ${power} dBm`);
            } else {
              setError("Usage: /power <dBm>");
            }
            return;
          }
          case "ch":
          case "channels": {
            try {
              const chs = await client.getAllChannels();
              setChannels(chs);
              const lines = chs.map(
                (c) =>
                  `CH${c.index}: ${c.name || "(empty)"} [${toHex(c.secret).slice(0, 8)}...]`,
              );
              addSystemMessage(
                `Channels:\n${lines.join("\n")}\nUse /to ch# to switch, /ch set <#> <name> to rename`,
              );
            } catch (e: any) {
              setError(`Failed to get channels: ${e.message}`);
            }
            return;
          }
          case "join": {
            const idx = parseInt(parts[1], 10);
            if (isNaN(idx)) {
              setError("Usage: /join <channel#>");
            } else {
              setChatTarget(`ch${idx}`);
              setChatChannel(idx);
              addSystemMessage(`Joined channel CH${idx}`);
            }
            return;
          }
          case "rooms": {
            const roomContacts = contacts.filter(
              (c) => c.typeName === "room",
            );
            if (roomContacts.length === 0) {
              addSystemMessage("No rooms found. Send /advert and /refresh to discover.");
            } else {
              const lines = roomContacts.map(
                (c) =>
                  `${c.name} (${c.publicKeyHex.slice(0, 8)}) hops:${c.pathLen} last:${c.lastAdvert > 0 ? timeSinceShort(c.lastAdvert) : "never"}`,
              );
              addSystemMessage(`Rooms:\n${lines.join("\n")}\nUse /to <room name> to DM a room.`);
            }
            return;
          }
          case "dm": {
            const target = parts.slice(1).join(" ");
            if (!target) {
              setError("Usage: /dm <contact name>");
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
          case "public":
            setChatTarget("public");
            setChatChannel(0);
            addSystemMessage("Target set to: PUBLIC CH0");
            return;
          case "remove": {
            const target = parts.slice(1).join(" ");
            if (!target) {
              setError("Usage: /remove <contact name>");
            } else {
              const contact = client.findContact(target);
              if (contact) {
                await client.removeContact(contact.publicKey);
                addSystemMessage(`Removed contact: ${contact.name}`);
                const cl = await client.getContacts();
                setContacts(cl);
              } else {
                setError(`Contact not found: ${target}`);
              }
            }
            return;
          }
          case "reboot":
            await client.reboot();
            addSystemMessage("Device rebooting...");
            return;
          case "help":
          case "h":
          case "?":
            setMode("help");
            return;
          default:
            setError(`Unknown command: ${cmd}`);
            return;
        }
      }

      // Send message
      try {
        if (chatTarget === "public" || chatTarget.startsWith("ch")) {
          await client.sendChannelMessage(chatChannel, value);
          setMessages((prev) => [
            ...prev,
            {
              id: ++msgIdCounter,
              timestamp: Math.floor(Date.now() / 1000),
              sender: "me",
              text: value,
              isSelf: true,
              channelIdx: chatChannel,
            },
          ]);
        } else {
          const contact = client.findContact(chatTarget);
          if (contact) {
            await client.sendTextMessage(contact.publicKey, value);
            setMessages((prev) => [
              ...prev,
              {
                id: ++msgIdCounter,
                timestamp: Math.floor(Date.now() / 1000),
                sender: "me",
                text: value,
                isSelf: true,
              },
            ]);
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

    // ── CHAT MODE: input is always active, only Tab/Esc switch away ──
    if (mode === "chat") {
      if (key.tab) {
        setMode("contacts");
        return;
      }
      // All other keys go to TextInput — don't intercept
      return;
    }

    // ── NON-CHAT MODES: keyboard shortcuts work freely ──

    // Enter goes back to chat to type
    if (key.return) {
      setMode("chat");
      return;
    }
    if (key.escape) {
      setMode("chat");
      return;
    }

    // Tab cycles views (skipping chat — use Enter/Esc for that)
    if (key.tab) {
      setMode((v) =>
        v === "contacts" ? "info" : v === "info" ? "config" : v === "config" ? "help" : "contacts",
      );
      return;
    }

    // Number keys switch modes
    if (ch === "1") { setMode("chat"); return; }
    if (ch === "2") { setMode("contacts"); return; }
    if (ch === "3") { setMode("info"); return; }
    if (ch === "4") { setMode("config"); return; }
    if (ch === "?") { setMode(mode === "help" ? "chat" : "help"); return; }

    // Contact navigation
    if (mode === "contacts") {
      if (ch === "j" || key.downArrow) {
        setSelectedContact((s) => Math.min(s + 1, contacts.length - 1));
      } else if (ch === "k" || key.upArrow) {
        setSelectedContact((s) => Math.max(0, s - 1));
      } else if (ch === "g") {
        setSelectedContact(0);
      } else if (ch === "G") {
        setSelectedContact(Math.max(0, contacts.length - 1));
      } else if (ch === "d" && contacts[selectedContact]) {
        setChatTarget(contacts[selectedContact].name);
        addSystemMessage(`Target set to DM: ${contacts[selectedContact].name}`);
        setMode("chat");
      }
    }

    // Config navigation
    if (mode === "config") {
      if (ch === "j" || key.downArrow) {
        setSelectedConfig((s) => s + 1);
      } else if (ch === "k" || key.upArrow) {
        setSelectedConfig((s) => Math.max(0, s - 1));
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
        justifyContent="space-between"
      >
        <Box gap={1}>
          <Text bold color={theme.fg.accent}>
            {"▓▓ MESHCORE"}
          </Text>
          <Text color={theme.fg.muted}>│</Text>
          <Text
            color={
              status === "connected" ? theme.status.online : theme.status.offline
            }
          >
            {status === "connected" ? "● ONLINE" : "○ OFFLINE"}
          </Text>
          {selfInfo && (
            <>
              <Text color={theme.fg.muted}>│</Text>
              <Text color={theme.fg.primary}>{selfInfo.name}</Text>
            </>
          )}
          {battery !== null && (
            <>
              <Text color={theme.fg.muted}>│</Text>
              <Text color={batteryColor(battery)}>⚡{battery}%</Text>
            </>
          )}
          {contacts.length > 0 && (
            <>
              <Text color={theme.fg.muted}>│</Text>
              <Text color={theme.fg.secondary}>{contacts.length} nodes</Text>
            </>
          )}
        </Box>
        <Box gap={0}>
          <ModeTab label="1⟩CHAT" active={mode === "chat"} />
          <Text> </Text>
          <ModeTab label="2⟩NODES" active={mode === "contacts"} />
          <Text> </Text>
          <ModeTab label="3⟩INFO" active={mode === "info"} />
          <Text> </Text>
          <ModeTab label="4⟩CFG" active={mode === "config"} />
          <Text> </Text>
          <Text color={theme.fg.muted}>?=help</Text>
        </Box>
      </Box>

      {/* ═══ ERROR BANNER ═══ */}
      {error && (
        <Box paddingX={1}>
          <Text color={theme.status.offline} bold>
            ▶ {error}
          </Text>
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
          />
        )}
        {mode === "contacts" && (
          <ContactsView
            contacts={contacts}
            height={rows - 5}
            selected={selectedContact}
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
            selfInfo={selfInfo}
            deviceInfo={deviceInfo}
            channels={channels}
            selected={selectedConfig}
          />
        )}
        {mode === "help" && <HelpView />}
      </Box>

      {/* ═══ INPUT BAR ═══ */}
      <Box
        borderStyle="single"
        borderColor={inputActive ? theme.border.focused : theme.border.normal}
        paddingX={1}
      >
        <Text color={theme.fg.accent} bold>
          [{targetLabel}]
        </Text>
        <Text color={inputActive ? theme.fg.accent : theme.fg.muted}>
          {" ❯ "}
        </Text>
        {inputActive ? (
          <TextInput value={input} onChange={setInput} onSubmit={handleSubmit} />
        ) : (
          <Text color={theme.fg.muted}>
            Press Enter to chat, 1-4 to switch views
          </Text>
        )}
      </Box>
    </Box>
  );
}

// ─── Sub-components ──────────────────────────────────────────────

function ModeTab({ label, active }: { label: string; active: boolean }) {
  return (
    <Text color={active ? theme.fg.accent : theme.fg.muted} bold={active}>
      {active ? `[${label}]` : ` ${label} `}
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
}: {
  messages: ChatMessage[];
  height: number;
  scrollOffset: number;
  targetLabel: string;
  cols: number;
}) {
  const visibleCount = Math.max(1, height - 2);
  const endIdx = messages.length - scrollOffset;
  const startIdx = Math.max(0, endIdx - visibleCount);
  const visible = messages.slice(startIdx, Math.max(0, endIdx));

  return (
    <Box flexDirection="column" paddingX={1}>
      {/* Chat header showing target */}
      <Box>
        <Text color={theme.fg.accent} bold>
          {"═══ MESSAGES"}
        </Text>
        <Text color={theme.fg.muted}> → </Text>
        <Text color={theme.message.channel} bold>
          {targetLabel}
        </Text>
        {messages.length > 0 && (
          <Text color={theme.fg.muted}>
            {" "}({messages.length} total)
          </Text>
        )}
        <Text color={theme.fg.muted}>
          {" ═══ Tab=switch views"}
        </Text>
      </Box>

      {visible.length === 0 && (
        <Box flexDirection="column" paddingY={1}>
          <Text color={theme.fg.muted}>
            {"  No messages yet. Start typing to send a message."}
          </Text>
          <Text color={theme.fg.muted}>
            {"  Use /to <name> to DM, /to public for broadcast, /help for all commands."}
          </Text>
        </Box>
      )}
      {scrollOffset > 0 && (
        <Text color={theme.fg.secondary}>
          {"  ▲ " + scrollOffset + " more above"}
        </Text>
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

        // Fixed-width columns: TIME(9) CHAN(6) SENDER(15) SNR(8) MSG(rest)
        // Truncate message to prevent wrapping
        const timeCol = time.padEnd(9);
        const chanCol = chTag.padEnd(6);
        const senderCol = m.sender.slice(0, 13).padEnd(15);
        const snrCol = snrStr ? snrStr.padStart(7) : "       ";
        const fixedWidth = 9 + 6 + 15 + 7 + 4; // columns + padding/gaps
        const maxMsgLen = Math.max(10, cols - fixedWidth);
        const msgText = m.text.length > maxMsgLen ? m.text.slice(0, maxMsgLen - 1) + "…" : m.text;

        return (
          <Box key={m.id} width={cols - 2}>
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
          </Box>
        );
      })}
    </Box>
  );
}

// ─── CONTACTS / NODES VIEW ───────────────────────────────────────

function ContactsView({
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
  const visibleCount = Math.max(1, height - 5);
  const startIdx = Math.max(
    0,
    Math.min(
      selected - Math.floor(visibleCount / 2),
      contacts.length - visibleCount,
    ),
  );
  const visible = contacts.slice(startIdx, startIdx + visibleCount);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={0}>
        <Text color={theme.fg.accent} bold>
          {"═══ NODES (" + contacts.length + ") ═══"}
        </Text>
      </Box>
      <Box>
        <Text color={theme.fg.secondary} bold>
          {"  "}
          {"NAME".padEnd(20)}
          {"TYPE".padEnd(12)}
          {"HOPS".padEnd(6)}
          {"KEY".padEnd(10)}
          {"LAST SEEN"}
        </Text>
      </Box>
      <Box>
        <Text color={theme.border.normal}>
          {"  " + "─".repeat(Math.min(70, cols - 4))}
        </Text>
      </Box>
      {contacts.length === 0 && (
        <Text color={theme.fg.muted}>
          {"  No contacts. Send /advert to announce yourself."}
        </Text>
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
              {prefix}
              {c.name.slice(0, 18).padEnd(20)}
            </Text>
            <Text
              backgroundColor={isSelected ? theme.bg.selected : undefined}
              color={typeColor}
            >
              {c.typeName.padEnd(12)}
            </Text>
            <Text
              backgroundColor={isSelected ? theme.bg.selected : undefined}
              color={
                c.pathLen <= 1
                  ? theme.status.online
                  : c.pathLen <= 3
                    ? theme.fg.accent
                    : theme.fg.secondary
              }
            >
              {String(c.pathLen).padEnd(6)}
            </Text>
            <Text
              backgroundColor={isSelected ? theme.bg.selected : undefined}
              color={theme.fg.muted}
            >
              {c.publicKeyHex.slice(0, 8).padEnd(10)}
            </Text>
            <Text
              backgroundColor={isSelected ? theme.bg.selected : undefined}
              color={theme.fg.muted}
            >
              {lastSeen}
            </Text>
          </Box>
        );
      })}
      <Box marginTop={1}>
        <Text color={theme.fg.muted}>
          j/k=navigate  g/G=top/bottom  d=DM  Enter=back to chat
        </Text>
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
        <Text color={theme.fg.accent} bold>
          {"═══ DEVICE INFO ═══"}
        </Text>
      </Box>

      <Box flexDirection="column">
        <InfoRow
          label="Name"
          value={selfInfo.name}
          valueColor={theme.fg.accent}
        />
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
        <InfoRow
          label="Frequency"
          value={`${selfInfo.freq.toFixed(3)} MHz`}
          valueColor={theme.message.channel}
        />
        <InfoRow label="Bandwidth" value={`${selfInfo.bw.toFixed(1)} kHz`} />
        <InfoRow
          label="SF / CR"
          value={`SF${selfInfo.sf} / CR${selfInfo.cr}`}
        />
        <InfoRow
          label="TX Power"
          value={`${selfInfo.txPower} / ${selfInfo.maxTxPower} dBm`}
        />
        {selfInfo.lat !== 0 && (
          <InfoRow
            label="Location"
            value={`${selfInfo.lat.toFixed(6)}, ${selfInfo.lon.toFixed(6)}`}
            valueColor="#00bfff"
          />
        )}
        <Text color={theme.border.normal}>{"  " + "─".repeat(45)}</Text>
        <InfoRow
          label="Public Key"
          value={toHex(selfInfo.publicKey).slice(0, 16) + "..."}
          valueColor={theme.fg.muted}
        />
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

function InfoRow({
  label,
  value,
  valueColor,
}: {
  label: string;
  value: string;
  valueColor?: string;
}) {
  return (
    <Box>
      <Text color={theme.fg.secondary}>{"  " + label.padEnd(14)}</Text>
      <Text color={valueColor ?? theme.fg.primary}>{value}</Text>
    </Box>
  );
}

// ─── CONFIG VIEW ─────────────────────────────────────────────────

function ConfigView({
  selfInfo,
  deviceInfo,
  channels,
  selected,
}: {
  selfInfo: SelfInfo | null;
  deviceInfo: DeviceInfo | null;
  channels: ChannelInfo[];
  selected: number;
}) {
  if (!selfInfo)
    return (
      <Box paddingX={1}>
        <Text color={theme.fg.muted}>Loading config...</Text>
      </Box>
    );

  const configItems = [
    { label: "Device Name", value: selfInfo.name, cmd: "/name <new name>" },
    {
      label: "TX Power",
      value: `${selfInfo.txPower} dBm (max ${selfInfo.maxTxPower})`,
      cmd: "/power <dBm>",
    },
    {
      label: "Frequency",
      value: `${selfInfo.freq.toFixed(3)} MHz`,
      cmd: "(set via firmware)",
    },
    {
      label: "Bandwidth",
      value: `${selfInfo.bw.toFixed(1)} kHz`,
      cmd: "(set via firmware)",
    },
    { label: "Spreading Factor", value: `SF${selfInfo.sf}`, cmd: "(set via firmware)" },
    { label: "Coding Rate", value: `CR${selfInfo.cr}`, cmd: "(set via firmware)" },
    {
      label: "Location",
      value:
        selfInfo.lat !== 0
          ? `${selfInfo.lat.toFixed(6)}, ${selfInfo.lon.toFixed(6)}`
          : "not set",
      cmd: "(set via firmware)",
    },
    {
      label: "Manual Add",
      value: selfInfo.manualAddContacts ? "enabled" : "disabled",
      cmd: "(set via firmware)",
    },
  ];

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={0}>
        <Text color={theme.fg.accent} bold>
          {"═══ CONFIGURATION ═══"}
        </Text>
      </Box>

      <Box marginBottom={1}>
        <Text color={theme.fg.secondary}>
          Use slash commands to modify settings. j/k to browse. Enter to chat.
        </Text>
      </Box>

      {configItems.map((item, i) => {
        const isSelected = i === selected;
        return (
          <Box key={item.label}>
            <Text
              backgroundColor={isSelected ? theme.bg.selected : undefined}
              color={isSelected ? theme.fg.accent : theme.fg.secondary}
            >
              {isSelected ? "▶ " : "  "}
              {item.label.padEnd(18)}
            </Text>
            <Text
              backgroundColor={isSelected ? theme.bg.selected : undefined}
              color={theme.fg.primary}
            >
              {item.value.padEnd(25)}
            </Text>
            <Text
              backgroundColor={isSelected ? theme.bg.selected : undefined}
              color={theme.fg.muted}
            >
              {item.cmd}
            </Text>
          </Box>
        );
      })}

      {channels.length > 0 && (
        <>
          <Box marginTop={1}>
            <Text color={theme.fg.accent} bold>
              {"═══ CHANNELS ═══"}
            </Text>
          </Box>
          {channels.map((ch) => (
            <Box key={ch.index}>
              <Text color={theme.fg.secondary}>
                {"  CH" + String(ch.index).padEnd(4)}
              </Text>
              <Text color={ch.name ? theme.fg.primary : theme.fg.muted}>
                {(ch.name || "(empty)").padEnd(25)}
              </Text>
              <Text color={theme.fg.muted}>
                {toHex(ch.secret).slice(0, 16)}...
              </Text>
            </Box>
          ))}
        </>
      )}

      {deviceInfo && (
        <>
          <Box marginTop={1}>
            <Text color={theme.fg.accent} bold>
              {"═══ DEVICE ═══"}
            </Text>
          </Box>
          <Box>
            <Text color={theme.fg.secondary}>
              {"  BLE PIN".padEnd(20)}
            </Text>
            <Text color={theme.fg.primary}>{deviceInfo.blePin}</Text>
          </Box>
          <Box>
            <Text color={theme.fg.secondary}>
              {"  Max Contacts".padEnd(20)}
            </Text>
            <Text color={theme.fg.primary}>{deviceInfo.maxContacts}</Text>
          </Box>
          <Box>
            <Text color={theme.fg.secondary}>
              {"  Max Channels".padEnd(20)}
            </Text>
            <Text color={theme.fg.primary}>{deviceInfo.maxChannels}</Text>
          </Box>
        </>
      )}
    </Box>
  );
}

// ─── HELP VIEW ───────────────────────────────────────────────────

function HelpView() {
  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Text color={theme.fg.accent} bold>
        {"╔══════════════════════════════════════════════╗"}
      </Text>
      <Text color={theme.fg.accent} bold>
        {"║         ▓▓ MESHCORE-TUI  HELP ▓▓            ║"}
      </Text>
      <Text color={theme.fg.accent} bold>
        {"╚══════════════════════════════════════════════╝"}
      </Text>

      <Box marginTop={1} flexDirection="column">
        <Text color={theme.message.channel} bold>
          Navigation
        </Text>
        <Text color={theme.border.normal}>{"─".repeat(42)}</Text>
        <HelpRow keys="Tab" desc="Cycle through views" />
        <HelpRow keys="Enter / Esc" desc="Return to chat (from any view)" />
        <HelpRow keys="1 / 2 / 3 / 4" desc="Jump to Chat/Nodes/Info/Config" />
        <HelpRow keys="?" desc="Toggle this help screen" />
        <HelpRow keys="Ctrl+C" desc="Quit" />
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text color={theme.message.channel} bold>
          Chat (input always active)
        </Text>
        <Text color={theme.border.normal}>{"─".repeat(42)}</Text>
        <HelpRow keys="Type + Enter" desc="Send message to current target" />
        <HelpRow keys="Tab" desc="Switch to nodes view" />
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text color={theme.message.channel} bold>
          Nodes
        </Text>
        <Text color={theme.border.normal}>{"─".repeat(42)}</Text>
        <HelpRow keys="j / k / ↑ / ↓" desc="Navigate contact list" />
        <HelpRow keys="g / G" desc="Jump to top / bottom" />
        <HelpRow keys="d" desc="DM selected contact" />
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text color={theme.message.channel} bold>
          Slash Commands (type in chat)
        </Text>
        <Text color={theme.border.normal}>{"─".repeat(42)}</Text>
        <HelpRow keys="/to <target>" desc="Set target (name, public, ch#)" />
        <HelpRow keys="/dm <name>" desc="DM a contact" />
        <HelpRow keys="/public" desc="Switch to public channel" />
        <HelpRow keys="/join <ch#>" desc="Join a channel" />
        <HelpRow keys="/channels" desc="List all channels" />
        <HelpRow keys="/rooms" desc="List room-type contacts" />
        <HelpRow keys="/contacts /info" desc="Switch views" />
        <HelpRow keys="/config" desc="Show configuration" />
        <HelpRow keys="/advert" desc="Send advertisement beacon" />
        <HelpRow keys="/name <n>" desc="Set device advertised name" />
        <HelpRow keys="/power <dBm>" desc="Set TX power" />
        <HelpRow keys="/refresh" desc="Reload contacts from device" />
        <HelpRow keys="/remove <name>" desc="Remove a contact" />
        <HelpRow keys="/reboot" desc="Reboot the radio" />
        <HelpRow keys="/quit" desc="Exit meshcore-tui" />
      </Box>

      <Box marginTop={1}>
        <Text color={theme.fg.muted}>Press ? or Enter or Esc to close</Text>
      </Box>
    </Box>
  );
}

function HelpRow({ keys, desc }: { keys: string; desc: string }) {
  return (
    <Box>
      <Text color={theme.fg.accent}> {keys.padEnd(20)}</Text>
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

function timeSinceShort(unixTimestamp: number): string {
  return timeSince(unixTimestamp);
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
