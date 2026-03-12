import React, { useState, useEffect, useCallback, useRef } from "react";
import { Box, Text, useInput, useApp } from "ink";
import TextInput from "ink-text-input";
import type { MeshCoreClient, Contact, ReceivedMessage, DeviceInfo, SelfInfo } from "../protocol/client";
import { toHex } from "../protocol/buffer";
import { contactTypeName } from "../protocol/constants";

interface ChatMessage {
  timestamp: number;
  sender: string;
  text: string;
  isSelf: boolean;
  channelIdx?: number;
  snr?: number;
}

type View = "chat" | "contacts" | "info";

interface AppProps {
  client: MeshCoreClient;
}

export default function App({ client }: AppProps) {
  const { exit } = useApp();
  const [view, setView] = useState<View>("chat");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [selfInfo, setSelfInfo] = useState<SelfInfo | null>(null);
  const [deviceInfo, setDeviceInfo] = useState<DeviceInfo | null>(null);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState("connected");
  const [chatTarget, setChatTarget] = useState<string>("public"); // "public" or contact name
  const [chatChannel, setChatChannel] = useState(0);
  const [battery, setBattery] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Initialize
  useEffect(() => {
    (async () => {
      try {
        // selfInfo was already set during appStart
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
        // Drain any queued messages
        const msgs = await client.syncAllMessages();
        for (const m of msgs) {
          addMessage(m);
        }
      } catch (e: any) {
        setError(e.message);
      }
    })();

    // Poll for messages
    pollRef.current = setInterval(async () => {
      try {
        const msgs = await client.syncAllMessages();
        for (const m of msgs) {
          addMessage(m);
        }
      } catch {}
    }, 2000);

    // Listen for push events
    client.on("messages_waiting", async () => {
      try {
        const msgs = await client.syncAllMessages();
        for (const m of msgs) {
          addMessage(m);
        }
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
      ...prev.slice(-200),
      {
        timestamp: m.timestamp,
        sender,
        text: m.text,
        isSelf: false,
        channelIdx: m.channelIdx,
        snr: m.snr,
      },
    ]);
  }, []);

  const handleSubmit = useCallback(
    async (value: string) => {
      if (!value.trim()) return;
      setInput("");

      // Commands
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
            setView("contacts");
            return;
          case "chat":
            setView("chat");
            return;
          case "info":
          case "i":
            setView("info");
            return;
          case "to": {
            const target = parts.slice(1).join(" ");
            if (!target || target === "public" || target === "0") {
              setChatTarget("public");
              setChatChannel(0);
            } else if (target.match(/^ch?\d+$/i)) {
              const idx = parseInt(target.replace(/^ch?/i, ""), 10);
              setChatTarget(`ch${idx}`);
              setChatChannel(idx);
            } else {
              const contact = client.findContact(target);
              if (contact) {
                setChatTarget(contact.name);
              } else {
                setError(`Contact not found: ${target}`);
              }
            }
            return;
          }
          case "advert":
            await client.sendAdvert();
            return;
          case "name":
            if (parts[1]) await client.setAdvertName(parts.slice(1).join(" "));
            return;
          case "refresh":
          case "r": {
            const cl = await client.getContacts();
            setContacts(cl);
            return;
          }
          case "reboot":
            await client.reboot();
            return;
          case "help":
          case "h":
          case "?":
            setMessages((prev) => [
              ...prev,
              {
                timestamp: Math.floor(Date.now() / 1000),
                sender: "system",
                text: [
                  "Commands: /to <name|public|ch#> - set target",
                  "/contacts - show contacts, /info - device info",
                  "/advert - send advertisement, /name <n> - set name",
                  "/refresh - reload contacts, /reboot - reboot device",
                  "/quit - exit",
                  "Keys: Tab=switch view, Ctrl+C=quit",
                ].join("\n"),
                isSelf: false,
              },
            ]);
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
    if (key.tab) {
      setView((v) => (v === "chat" ? "contacts" : v === "contacts" ? "info" : "chat"));
    }
  });

  const targetLabel =
    chatTarget === "public" ? "public (ch0)" : chatTarget.startsWith("ch") ? chatTarget : `DM: ${chatTarget}`;

  return (
    <Box flexDirection="column" width="100%">
      {/* Header */}
      <Box borderStyle="single" paddingX={1}>
        <Text bold color="green">
          meshcore-tui
        </Text>
        <Text> | </Text>
        <Text color={status === "connected" ? "green" : "red"}>{status}</Text>
        {selfInfo && (
          <>
            <Text> | </Text>
            <Text>{selfInfo.name}</Text>
          </>
        )}
        {battery !== null && (
          <>
            <Text> | </Text>
            <Text color={battery > 20 ? "green" : "red"}>bat:{battery}%</Text>
          </>
        )}
        <Text> | </Text>
        <Text dimColor>
          [{view === "chat" ? "*chat" : "chat"}] [{view === "contacts" ? "*contacts" : "contacts"}] [
          {view === "info" ? "*info" : "info"}]
        </Text>
        <Text> Tab=switch /help</Text>
      </Box>

      {/* Error banner */}
      {error && (
        <Box paddingX={1}>
          <Text color="red" bold>
            Error: {error}
          </Text>
        </Box>
      )}

      {/* Main content */}
      <Box flexGrow={1} flexDirection="column" paddingX={1}>
        {view === "chat" && <ChatView messages={messages} />}
        {view === "contacts" && <ContactsView contacts={contacts} />}
        {view === "info" && <InfoView deviceInfo={deviceInfo} battery={battery} />}
      </Box>

      {/* Input */}
      <Box borderStyle="single" paddingX={1}>
        <Text color="cyan">{targetLabel}{">"} </Text>
        <TextInput value={input} onChange={setInput} onSubmit={handleSubmit} />
      </Box>
    </Box>
  );
}

function ChatView({ messages }: { messages: ChatMessage[] }) {
  const visible = messages.slice(-30);
  return (
    <Box flexDirection="column">
      {visible.length === 0 && <Text dimColor>No messages yet. Type to chat, /help for commands.</Text>}
      {visible.map((m) => {
        const key = `${m.timestamp}-${m.sender}-${m.text.slice(0, 20)}`;
        const time = new Date(m.timestamp * 1000).toLocaleTimeString();
        const chLabel = m.channelIdx !== undefined ? `[ch${m.channelIdx}]` : "";
        const snrLabel = m.snr !== undefined ? ` (${m.snr.toFixed(1)}dB)` : "";
        return (
          <Box key={key}>
            <Text dimColor>{time} </Text>
            {chLabel && <Text color="yellow">{chLabel} </Text>}
            <Text color={m.isSelf ? "green" : m.sender === "system" ? "gray" : "blue"} bold={!m.isSelf}>
              {m.sender}
            </Text>
            <Text>: {m.text}</Text>
            {snrLabel && <Text dimColor>{snrLabel}</Text>}
          </Box>
        );
      })}
    </Box>
  );
}

function ContactsView({ contacts }: { contacts: Contact[] }) {
  return (
    <Box flexDirection="column">
      <Box>
        <Text bold underline>
          {"Name".padEnd(20)} {"Type".padEnd(10)} {"Path".padEnd(6)} {"Key (short)".padEnd(12)} Last Seen
        </Text>
      </Box>
      {contacts.length === 0 && <Text dimColor>No contacts. Send /advert to announce yourself.</Text>}
      {contacts.map((c) => {
        const lastSeen = c.lastAdvert > 0 ? new Date(c.lastAdvert * 1000).toLocaleString() : "never";
        const typeColor =
          c.typeName === "repeater" ? "magenta" : c.typeName === "room" ? "cyan" : c.typeName === "client" ? "blue" : "yellow";
        return (
          <Box key={c.publicKeyHex}>
            <Text>{c.name.padEnd(20)} </Text>
            <Text color={typeColor}>{c.typeName.padEnd(10)} </Text>
            <Text>{String(c.pathLen).padEnd(6)} </Text>
            <Text dimColor>{c.publicKeyHex.slice(0, 8).padEnd(12)} </Text>
            <Text dimColor>{lastSeen}</Text>
          </Box>
        );
      })}
    </Box>
  );
}

function InfoView({ deviceInfo, battery }: { deviceInfo: DeviceInfo | null; battery: number | null }) {
  if (!deviceInfo) return <Text dimColor>Loading device info...</Text>;
  return (
    <Box flexDirection="column">
      <Text bold underline>
        Device Information
      </Text>
      <Text>Name: {deviceInfo.adName}</Text>
      <Text>Firmware: {deviceInfo.firmwareVer}</Text>
      <Text>Max Contacts: {deviceInfo.maxContacts}</Text>
      <Text>Max Channels: {deviceInfo.maxChannels}</Text>
      <Text>
        Radio: {deviceInfo.freq.toFixed(3)} MHz, BW={deviceInfo.bw.toFixed(1)}, SF={deviceInfo.sf}, CR={deviceInfo.cr}
      </Text>
      <Text>TX Power: {deviceInfo.txPower} dBm</Text>
      {deviceInfo.lat !== 0 && (
        <Text>
          Location: {deviceInfo.lat.toFixed(6)}, {deviceInfo.lon.toFixed(6)}
        </Text>
      )}
      <Text>Public Key: {toHex(deviceInfo.publicKey).slice(0, 16)}...</Text>
      {battery !== null && <Text>Battery: {battery}%</Text>}
    </Box>
  );
}
