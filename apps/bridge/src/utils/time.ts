export function nowIso() {
  return new Date().toISOString();
}

export function toIsoFromUnixSeconds(seconds: number) {
  return new Date(seconds * 1000).toISOString();
}
