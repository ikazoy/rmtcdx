import os from "node:os";

type NetworkInterfaceInfo = ReturnType<typeof os.networkInterfaces>;

export function preferredPrivateIpv4(interfaces: NetworkInterfaceInfo = os.networkInterfaces()) {
  const candidates: string[] = [];

  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal || !isPrivateIpv4(entry.address)) {
        continue;
      }

      candidates.push(entry.address);
    }
  }

  return selectPreferredPrivateIpv4(candidates);
}

export function selectPreferredPrivateIpv4(addresses: string[]) {
  return [...addresses]
    .sort((left, right) => privateAddressPriority(left) - privateAddressPriority(right) || left.localeCompare(right))
    .at(0) ?? null;
}

function isPrivateIpv4(address: string) {
  if (address.startsWith("192.168.")) {
    return true;
  }

  if (address.startsWith("10.")) {
    return true;
  }

  const octets = address.split(".");
  if (octets.length !== 4) {
    return false;
  }

  const first = Number(octets[0]);
  const second = Number(octets[1]);
  return first === 172 && Number.isInteger(second) && second >= 16 && second <= 31;
}

function privateAddressPriority(address: string) {
  if (address.startsWith("192.168.")) {
    return 0;
  }

  if (address.startsWith("10.")) {
    return 1;
  }

  return 2;
}
