#!/usr/bin/env bun
// meshcore-tui — Terminal UI for MeshCore mesh radios

import React from "react";
import { render } from "ink";
import App from "./ui/App";
import { MeshCoreClient } from "./protocol/client";
import { DEFAULT_TCP_PORT } from "./protocol/constants";

function usage(): never {
  console.log(`Usage: meshcore-tui <address> [options]

  ▓▓ MESHCORE-TUI — Cyberpunk terminal UI for MeshCore mesh radios

  Arguments:
    address              Device IP address or hostname

  Options:
    -p, --port <port>    TCP port (default: ${DEFAULT_TCP_PORT})
    -h, --help           Show this help

  Keybindings:
    1 / 2 / 3 / 4       Chat / Nodes / Info / Config
    Tab                  Cycle views
    ?                    Toggle help
    i / Enter            Focus text input
    Esc                  Unfocus / return to chat
    j / k                Navigate (nodes/config view)
    Ctrl+C               Quit

  Commands:
    /to <name|public|ch#>  Set chat target
    /contacts              Show contacts
    /info                  Show device info
    /config                Show configuration
    /advert                Send advertisement beacon
    /name <name>           Set device name
    /power <dBm>           Set TX power
    /refresh               Reload contacts
    /reboot                Reboot the radio
    /quit                  Exit
`);
  process.exit(0);
}

// Parse args
const args = process.argv.slice(2);
let host: string | null = null;
let port = DEFAULT_TCP_PORT;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "-h" || arg === "--help") usage();
  else if (arg === "-p" || arg === "--port") port = parseInt(args[++i], 10);
  else if (!arg.startsWith("-")) host = arg;
}

if (!host) {
  console.error("Error: address is required\n");
  usage();
}

async function main() {
  const client = new MeshCoreClient(host!, port);

  console.log(`Connecting to ${host}:${port}...`);

  try {
    await client.connect();
  } catch (e: any) {
    console.error(`Failed to connect: ${e.message}`);
    process.exit(1);
  }

  try {
    await client.appStart("mccli");
  } catch (e: any) {
    console.error(`Handshake failed: ${e.message}`);
    process.exit(1);
  }

  console.log("Connected! Loading...\n");

  const { unmount, waitUntilExit } = render(<App client={client} />, {
    patchConsole: true,
  });

  const cleanup = () => {
    client.disconnect();
    unmount();
  };

  process.on("SIGINT", () => { cleanup(); process.exit(0); });
  process.on("SIGTERM", () => { cleanup(); process.exit(0); });

  client.on("disconnected", () => {
    unmount();
    console.log("\nDisconnected.");
    process.exit(0);
  });

  await waitUntilExit();
  client.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
