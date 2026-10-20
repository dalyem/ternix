/**
 * Where a local or dynamic forward may listen on this computer: an IP address or `localhost`.
 * Any other name would be looked up in DNS when the forward starts, a lookup no dialog
 * approved (the name itself could carry data out). Main checks again with `net.isIP`.
 */
export const BIND_ADDRESS_MESSAGE = 'Bind address must be an IP address or localhost';

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
/** Loose on purpose (the renderer only uses it to explain early); main is exact. */
const IPV6 = /^(?=.*:)[0-9a-f:.]+(%[0-9a-z_.-]+)?$/i;

export function looksLikeLocalBindAddress(address: string): boolean {
  const a = address.trim();
  return a.toLowerCase() === 'localhost' || IPV4.test(a) || IPV6.test(a);
}
