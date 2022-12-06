import {
  PoolCreated,
  PoolCreated as PoolCreatedEvent
} from "../../generated/WeightedPoolNoAMFactory/WeightedPoolNoAMFactory";
import { ERC20 } from "../../generated/WeightedPoolNoAMFactory/ERC20";
import { Balancer, Pool } from "../../generated/schema";
import { Bytes, BigInt, Address } from "@graphprotocol/graph-ts";
import { createDefaultPoolEntity, getBalancerSnapshot, scaleDown } from "../utils/misc";
import { ZERO, ZERO_BD } from "../utils/constants";

export function handlePoolCreated(event: PoolCreatedEvent): void {
  let pool = new Pool(event.params.pool.toHexString());

  pool.save();
}

function findOrInitializeVault(): Balancer {
  let vault: Balancer | null = Balancer.load("2");
  if (vault != null) return vault;

  // if no vault yet, set up blank initial
  vault = new Balancer("2");
  vault.poolCount = 0;
  vault.totalLiquidity = ZERO_BD;
  vault.totalSwapVolume = ZERO_BD;
  vault.totalSwapFee = ZERO_BD;
  vault.totalSwapCount = ZERO;
  return vault;
}

function handleNewPool(event: PoolCreated, poolId: Bytes, swapFee: BigInt) {
  let pool = Pool.load(poolId.toHexString());
  if (pool == null) {
    pool = createDefaultPoolEntity(poolId.toHexString());

    let poolAddress: Address = event.params.pool;
    pool.swapFee = scaleDown(swapFee, 18);
    pool.createTime = event.block.timestamp.toI32();
    pool.address = poolAddress;
    pool.factory = event.address;
    pool.oracleEnabled = false;
    pool.tx = event.transaction.hash;
    pool.swapEnabled = true;

    let bpt = ERC20.bind(poolAddress);

    let nameCall = bpt.try_name();
    if (!nameCall.reverted) {
      pool.name = nameCall.value;
    }

    let symbolCall = bpt.try_symbol();
    if (!symbolCall.reverted) {
      pool.symbol = symbolCall.value;
    }

    pool.save();

    let vault = findOrInitializeVault();
    vault.poolCount += 1;
    vault.save();

    let vaultSnapshot = getBalancerSnapshot(vault.id, event.block.timestamp.toI32());
    vaultSnapshot.poolCount += 1;
    vaultSnapshot.save();
  }

  return pool;
}
