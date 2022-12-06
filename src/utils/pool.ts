import { Address, Bytes, log } from "@graphprotocol/graph-ts";

export function getPoolAddress(poolId: string): Address {
  return changetype<Address>(Address.fromHexString(poolId.slice(0, 42)));
}
