import { BigDecimal, Address, BigInt, ethereum, Bytes } from "@graphprotocol/graph-ts";
import { Balancer, BalancerSnapshot, Pool, PoolShare, User } from "../../generated/schema";
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

export function createDefaultPoolEntity(poolId: string): Pool {
  let pool = new Pool(poolId);
  pool.vaultID = "2";
  pool.strategyType = i32(parseInt(poolId.slice(42, 46)));
  pool.tokensList = [];
  pool.totalWeight = ZERO_BD;
  pool.totalSwapVolume = ZERO_BD;
  pool.totalSwapFee = ZERO_BD;
  pool.totalLiquidity = ZERO_BD;
  pool.totalShares = ZERO_BD;
  pool.swapsCount = BigInt.fromI32(0);
  pool.holdersCount = BigInt.fromI32(0);

  return pool;
}

export function getBalancerSnapshot(vaultId: string, timestamp: i32): BalancerSnapshot {
  let dayID = timestamp / 86400;
  let id = vaultId + "-" + dayID.toString();
  let snapshot = BalancerSnapshot.load(id);

  if (snapshot == null) {
    let dayStartTimestamp = dayID * 86400;
    snapshot = new BalancerSnapshot(id);
    // we know that the vault should be created by this call
    let vault = Balancer.load("2") as Balancer;
    snapshot.poolCount = vault.poolCount;

    snapshot.totalLiquidity = vault.totalLiquidity;
    snapshot.totalSwapFee = vault.totalSwapFee;
    snapshot.totalSwapVolume = vault.totalSwapVolume;
    snapshot.totalSwapCount = vault.totalSwapCount;
    snapshot.vault = vaultId;
    snapshot.timestamp = dayStartTimestamp;
    snapshot.save();
  }

  return snapshot;
}
