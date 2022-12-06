import { BigDecimal, Address, BigInt, ethereum, Bytes } from "@graphprotocol/graph-ts";
import { PoolShare, User } from "../../generated/schema";
import { ZERO_BD } from "./constants";
import { getPoolAddress } from "./pool";

export function scaleDown(num: BigInt, decimals: i32): BigDecimal {
  return num.divDecimal(
    BigInt.fromI32(10)
      .pow(u8(decimals))
      .toBigDecimal()
  );
}

export function tokenToDecimal(amount: BigInt, decimals: i32): BigDecimal {
  let scale = BigInt.fromI32(10)
    .pow(decimals as u8)
    .toBigDecimal();
  return amount.toBigDecimal().div(scale);
}

export function getPoolShareId(poolControllerAddress: Address, lpAddress: Address): string {
  return poolControllerAddress
    .toHex()
    .concat("-")
    .concat(lpAddress.toHex());
}

export function getPoolShare(poolId: string, lpAddress: Address): PoolShare {
  let poolShareId = getPoolShareId(getPoolAddress(poolId), lpAddress);
  let poolShare = PoolShare.load(poolShareId);
  if (poolShare == null) {
    return createPoolShareEntity(poolId, lpAddress);
  }
  return poolShare;
}

export function createPoolShareEntity(poolId: string, lpAddress: Address): PoolShare {
  let id = getPoolShareId(getPoolAddress(poolId), lpAddress);
  let poolShare = new PoolShare(id);
  poolShare.userAddress = lpAddress.toHex();
  poolShare.poolId = poolId;
  poolShare.balance = ZERO_BD;
  poolShare.save();
  return poolShare;
}

export function createUserEntity(address: Address): void {
  let addressHex = address.toHex();
  if (User.load(addressHex) == null) {
    let user = new User(addressHex);
    user.save();
  }
}
