export type KeyedListItem = {
  key: string;
};

export function resolveActiveItemKey<T extends KeyedListItem>({
  items,
  currentKey,
  preferredKey
}: {
  items: readonly T[];
  currentKey: string | null;
  preferredKey?: string | null;
}) {
  if (currentKey && items.some((item) => item.key === currentKey)) {
    return currentKey;
  }

  if (preferredKey && items.some((item) => item.key === preferredKey)) {
    return preferredKey;
  }

  return items[0]?.key ?? null;
}

export function moveActiveItemKey<T extends KeyedListItem>({
  items,
  currentKey,
  delta
}: {
  items: readonly T[];
  currentKey: string | null;
  delta: -1 | 1;
}) {
  if (items.length === 0) {
    return null;
  }

  const currentIndex = items.findIndex((item) => item.key === currentKey);
  const startIndex = currentIndex === -1 ? (delta > 0 ? -1 : 0) : currentIndex;
  const nextIndex = (startIndex + delta + items.length) % items.length;
  return items[nextIndex]?.key ?? null;
}
