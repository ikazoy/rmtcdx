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

export function formatClock(iso: string) {
  return new Intl.DateTimeFormat("en", {
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(iso));
}
