// Cyberpunk neon color theme for meshcore-tui
// Matching meshtastic-cli aesthetic
export const theme = {
  bg: {
    primary: "#0a0e14",
    panel: "#0d1117",
    selected: "#2a3a50",
  },
  fg: {
    primary: "#c5c8c6",
    secondary: "#6e7681",
    accent: "#00ff9f",
    muted: "#3d444c",
  },
  border: {
    focused: "#00ff9f",
    normal: "#2d333b",
  },
  status: {
    online: "#00ff9f",
    offline: "#ff0040",
    warning: "#ff9f00",
  },
  contact: {
    client: "#00bfff",
    repeater: "#ff00cc",
    room: "#00ccff",
    unknown: "#ff9f00",
  },
  message: {
    self: "#00ff9f",
    other: "#00bfff",
    system: "#6e7681",
    channel: "#ffff00",
  },
  signal: {
    good: "#00ff88",
    fair: "#ff9f00",
    poor: "#ff6600",
    none: "#ff0040",
  },
  battery: {
    good: "#00ff00",
    low: "#ff9f00",
    critical: "#ff4400",
  },
};

export function snrColor(snr: number): string {
  if (snr >= 5) return theme.signal.good;
  if (snr >= 0) return theme.signal.fair;
  if (snr >= -10) return theme.signal.poor;
  return theme.signal.none;
}

export function batteryColor(pct: number): string {
  if (pct > 40) return theme.battery.good;
  if (pct > 15) return theme.battery.low;
  return theme.battery.critical;
}

// Distinct colors for different usernames in chat
const usernameColors = [
  "#00bfff", // cyan
  "#ff00cc", // magenta
  "#ffff00", // yellow
  "#ff6600", // orange
  "#00ff88", // green
  "#ff4488", // pink
  "#44ddff", // light blue
  "#cc88ff", // lavender
  "#ff9f00", // amber
  "#00ccaa", // teal
];

export function usernameColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  }
  return usernameColors[Math.abs(hash) % usernameColors.length];
}

export function contactColor(typeName: string): string {
  switch (typeName) {
    case "client": return theme.contact.client;
    case "repeater": return theme.contact.repeater;
    case "room": return theme.contact.room;
    default: return theme.contact.unknown;
  }
}
