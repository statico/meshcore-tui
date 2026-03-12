import React, { useState, useEffect, useCallback, useRef } from "react";
import { Box, Text, useInput, useApp, useStdout } from "ink";
import TextInput from "ink-text-input";
import type { MeshCoreClient, Contact, ReceivedMessage, DeviceInfo, SelfInfo } from "../protocol/client";
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

type Mode = "chat" | "contacts" | "info" | "help";

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
  const [input, setInput] = useState("");
  const [status, setStatus] = useState("connected");
  const [chatTarget, setChatTarget] = useState<string>("public");
  const [chatChannel, setChatChannel] = useState(0);
  const [battery, setBattery] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [selectedContact, setSelectedContact] = useState(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

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
        } catch {}
        const msgs = await client.syncAllMessages();
        for (const m of msgs) addMessage(m);
      } catch (e: any) {
        setError(e.message);
      }
    })();

    pollRef.current = setInterval(async () => {
      try {
        const msgs = await client.syncAllMessages();
        for (const m of msgs) addMessage(m);
      } catch {}
    }, 2000);

    client.on("messages_waiting", async () => {
      try {
        const msgs = await client.syncAllMessages();
        for (const m of msgs) addMessage(m);
      } catch {}
    });

    client.on("disconnected", () => setStatus("disconnected"));

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const addMessage = useCallback((m: ReceivedMessage) => {
    const sender = client.resolveContactName(m.senderKey);
    setMessages((prev) => [
      ...prev.slice(-500),
      {
        id: ++msgIdCounter,
        timestamp: m.timestamp,
        sender,
        text: m.text,
        isSelf: false,
        channelIdx: m.channelIdx,
        snr: m.snr,
      },
    ]);
    setScrollOffset(0);
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
            addSystemMessage("Advertisement beacon sent");
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
    // Clear error on any keypress
    if (error) setError(null);

    // Mode switching via number keys
    if (ch === "1") { setMode("chat"); return; }
    if (ch === "2") { setMode("contacts"); return; }
    if (ch === "3") { setMode("info"); return; }
    if (ch === "?") { setMode(mode === "help" ? "chat" : "help"); return; }
    if (key.tab) {
      setMode((v) => v === "chat" ? "contacts" : v === "contacts" ? "info" : "chat");
      return;
    }
    if (key.escape) { setMode("chat"); return; }

    // Vim-style scrolling in chat mode
    if (mode === "chat") {
      if (key.upArrow) setScrollOffset((s) => Math.min(s + 1, Math.max(0, messages.length - 5)));
      else if (key.downArrow) setScrollOffset((s) => Math.max(0, s - 1));
    }

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
      } else if (key.return && contacts[selectedContact]) {
        setChatTarget(contacts[selectedContact].name);
        addSystemMessage(`Target set to DM: ${contacts[selectedContact].name}`);
        setMode("chat");
      } else if (ch === "d" && contacts[selectedContact]) {
        setChatTarget(contacts[selectedContact].name);
        addSystemMessage(`Target set to DM: ${contacts[selectedContact].name}`);
        setMode("chat");
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
          <Text color={status === "connected" ? theme.status.online : theme.status.offline}>
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
            contacts={contacts}
          />
        )}
        {mode === "help" && <HelpView />}
      </Box>

      {/* ═══ INPUT BAR ═══ */}
      <Box
        borderStyle="single"
        borderColor={theme.border.focused}
        paddingX={1}
      >
        <Text color={theme.fg.accent} bold>
          [{targetLabel}]
        </Text>
        <Text color={theme.fg.accent}>{" ❯ "}</Text>
        <TextInput value={input} onChange={setInput} onSubmit={handleSubmit} />
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
  cols,
}: {
  messages: ChatMessage[];
  height: number;
  scrollOffset: number;
  cols: number;
}) {
  const visibleCount = Math.max(1, height - 1);
  const endIdx = messages.length - scrollOffset;
  const startIdx = Math.max(0, endIdx - visibleCount);
  const visible = messages.slice(startIdx, Math.max(0, endIdx));

  return (
    <Box flexDirection="column" paddingX={1}>
      {visible.length === 0 && (
        <Box flexDirection="column" paddingY={1}>
          <Text color={theme.fg.muted}>
            {"  ╔══════════════════════════════════════════╗"}
          </Text>
          <Text color={theme.fg.muted}>
            {"  ║   No messages yet.                       ║"}
          </Text>
          <Text color={theme.fg.muted}>
            {"  ║   Type a message or ? for help            ║"}
          </Text>
          <Text color={theme.fg.muted}>
            {"  ╚══════════════════════════════════════════╝"}
          </Text>
        </Box>
      )}
      {scrollOffset > 0 && (
        <Text color={theme.fg.secondary}>
          {"  ▲ " + scrollOffset + " more above (↑ to scroll)"}
        </Text>
      )}
      {visible.map((m) => {
        const time = new Date(m.timestamp * 1000).toLocaleTimeString("en-US", {
          hour12: false,
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        });
        const chLabel = m.channelIdx !== undefined ? `[CH${m.channelIdx}]` : "";
        const snrLabel = m.snr !== undefined ? ` ${m.snr.toFixed(1)}dB` : "";

        const senderColor = m.isSelf
          ? theme.message.self
          : m.sender === "system"
            ? theme.message.system
            : theme.message.other;

        return (
          <Box key={m.id}>
            <Text color={theme.fg.muted}>[{time}] </Text>
            {chLabel && <Text color={theme.message.channel}>{chLabel} </Text>}
            <Text color={senderColor} bold={!m.isSelf}>
              {m.sender.slice(0, 12).padEnd(12)}
            </Text>
            <Text color={theme.fg.primary}> {m.text}</Text>
            {snrLabel && (
              <Text color={m.snr !== undefined ? snrColor(m.snr) : theme.fg.muted}>
                {snrLabel}
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
    Math.min(selected - Math.floor(visibleCount / 2), contacts.length - visibleCount),
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
        const lastSeen =
          c.lastAdvert > 0
            ? timeSince(c.lastAdvert)
            : "never";
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
              color={c.pathLen <= 1 ? theme.status.online : c.pathLen <= 3 ? theme.fg.accent : theme.fg.secondary}
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
          j/k=navigate  g/G=top/bottom  Enter/d=DM  /to {"<name>"} to target
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
  contacts,
}: {
  selfInfo: SelfInfo | null;
  deviceInfo: DeviceInfo | null;
  battery: number | null;
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
        <InfoRow label="Name" value={selfInfo.name} valueColor={theme.fg.accent} />
        {deviceInfo && (
          <>
            <InfoRow label="Firmware" value={`v${deviceInfo.firmwareVer}`} />
            <InfoRow label="Build" value={deviceInfo.buildDate} />
            <InfoRow label="Model" value={deviceInfo.model} />
          </>
        )}
        <Text color={theme.border.normal}>{"  " + "─".repeat(45)}</Text>
        <InfoRow
          label="Frequency"
          value={`${selfInfo.freq.toFixed(3)} MHz`}
          valueColor={theme.message.channel}
        />
        <InfoRow label="Bandwidth" value={`${selfInfo.bw.toFixed(1)} kHz`} />
        <InfoRow label="SF / CR" value={`SF${selfInfo.sf} / CR${selfInfo.cr}`} />
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
            value={`${battery}%`}
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
          Global Shortcuts
        </Text>
        <Text color={theme.border.normal}>{"─".repeat(35)}</Text>
        <HelpRow keys="1 / 2 / 3" desc="Switch to Chat / Nodes / Info" />
        <HelpRow keys="Tab" desc="Cycle through views" />
        <HelpRow keys="?" desc="Toggle this help screen" />
        <HelpRow keys="Esc" desc="Return to chat" />
        <HelpRow keys="Ctrl+C" desc="Quit" />
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text color={theme.message.channel} bold>
          Chat Mode
        </Text>
        <Text color={theme.border.normal}>{"─".repeat(35)}</Text>
        <HelpRow keys="↑ / ↓" desc="Scroll message history" />
        <HelpRow keys="Enter" desc="Send message to current target" />
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text color={theme.message.channel} bold>
          Nodes Mode
        </Text>
        <Text color={theme.border.normal}>{"─".repeat(35)}</Text>
        <HelpRow keys="j / k / ↑ / ↓" desc="Navigate contact list" />
        <HelpRow keys="g / G" desc="Jump to top / bottom" />
        <HelpRow keys="Enter / d" desc="DM selected contact" />
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text color={theme.message.channel} bold>
          Slash Commands
        </Text>
        <Text color={theme.border.normal}>{"─".repeat(35)}</Text>
        <HelpRow keys="/to <target>" desc="Set target (name, public, ch#)" />
        <HelpRow keys="/contacts" desc="Show contacts list" />
        <HelpRow keys="/info" desc="Show device info" />
        <HelpRow keys="/advert" desc="Send advertisement beacon" />
        <HelpRow keys="/name <n>" desc="Set device advertised name" />
        <HelpRow keys="/refresh" desc="Reload contacts from device" />
        <HelpRow keys="/reboot" desc="Reboot the radio" />
        <HelpRow keys="/quit" desc="Exit meshcore-tui" />
      </Box>

      <Box marginTop={1}>
        <Text color={theme.fg.muted}>Press ? or Esc to close help</Text>
      </Box>
    </Box>
  );
}

function HelpRow({ keys, desc }: { keys: string; desc: string }) {
  return (
    <Box>
      <Text color={theme.fg.accent}> {keys.padEnd(18)}</Text>
      <Text color={theme.fg.primary}>{desc}</Text>
    </Box>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────

function timeSince(unixTimestamp: number): string {
  const now = Math.floor(Date.now() / 1000);
  const diff = now - unixTimestamp;
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}
