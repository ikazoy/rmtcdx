export function formatRelativeTime(iso: string) {
  const value = new Date(iso).getTime();
  if (Number.isNaN(value)) {
    return "just now";
  }

  const deltaSeconds = Math.round((value - Date.now()) / 1000);
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60]
  ];

  for (const [unit, size] of units) {
    if (Math.abs(deltaSeconds) >= size || unit === "minute") {
      return rtf.format(Math.round(deltaSeconds / size), unit);
    }
  }

  return "just now";
}

export function formatCompactTimeUntil(iso: string, now = Date.now()) {
  const value = new Date(iso).getTime();
  if (Number.isNaN(value)) {
    return null;
  }

  const deltaMs = value - now;
  if (deltaMs <= 0) {
    return "now";
  }

  const totalMinutes = Math.max(1, Math.ceil(deltaMs / 60000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) {
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }

  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }

  return `${totalMinutes}m`;
}

export function formatClock(iso: string) {
  return new Intl.DateTimeFormat("en", {
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(iso));
}
