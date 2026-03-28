export function truncate(text: string, max = 96) {
  if (text.length <= max) {
    return text;
  }

  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export function excerpt(text: string, max = 160) {
  return truncate(text.replace(/\s+/g, " ").trim(), max);
}

export function deriveTitle(prompt: string) {
  const clean = prompt.replace(/\s+/g, " ").trim();
  return clean ? truncate(clean, 48) : "New session";
}
