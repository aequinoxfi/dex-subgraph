import {
  PoolCreated,
  PoolCreated as PoolCreatedEvent
} from "../../generated/WeightedPoolNoAMFactory/WeightedPoolNoAMFactory";
import { ERC20 } from "../../generated/WeightedPoolNoAMFactory/ERC20";
import { Balancer, Pool } from "../../generated/schema";
import { Bytes, BigInt, Address } from "@graphprotocol/graph-ts";
import {
  createDefaultPoolEntity,
  createPoolTokenEntity,
  getBalancerSnapshot,
  scaleDown,
  stringToBytes
} from "../utils/misc";
import { ZERO, ZERO_BD } from "../utils/constants";
import { WeightedPool as WeightedPoolTemplate } from "../../generated/templates";
import { StablePool as StablePoolTemplate } from "../../generated/templates";
import { getPoolTokenManager, getPoolTokens, PoolType } from "../utils/pool";
import { updatePoolWeights } from "../utils/weighted";
import { WeightedPool } from "../../generated/templates/WeightedPool/WeightedPool";
import { StablePool } from "../../generated/StablePoolFactory/StablePool";

function createWeightedLikePool(
  event: PoolCreated,
  poolType: string,
  poolTypeVersion: i32 = 1
): string | null {
  let poolAddress: Address = event.params.pool;
  let poolContract = WeightedPool.bind(poolAddress);

  let poolIdCall = poolContract.try_getPoolId();
  let poolId = poolIdCall.value;

  let swapFeeCall = poolContract.try_getSwapFeePercentage();
  let swapFee = swapFeeCall.value;

  let ownerCall = poolContract.try_getOwner();
  let owner = ownerCall.value;

  let pool = handleNewPool(event, poolId, swapFee);
  pool.poolType = poolType;
  pool.poolTypeVersion = poolTypeVersion;
  pool.owner = owner;

  let tokens = getPoolTokens(poolId);
  if (tokens == null) return null;
  pool.tokensList = tokens;

  pool.save();

  handleNewPoolTokens(pool, tokens);

  // Load pool with initial weights
  updatePoolWeights(poolId.toHexString());

  // Create PriceRateProvider entities for WeightedPoolV2
  // if (poolTypeVersion == 2) setPriceRateProviders(poolId.toHex(), poolAddress, tokens);

  return poolId.toHexString();
}

function createStableLikePool(
  event: PoolCreated,
  poolType: string,
  poolTypeVersion: i32 = 1
): string | null {
  let poolAddress: Address = event.params.pool;
  let poolContract = StablePool.bind(poolAddress);

  let poolIdCall = poolContract.try_getPoolId();
  let poolId = poolIdCall.value;

  let swapFeeCall = poolContract.try_getSwapFeePercentage();
  let swapFee = swapFeeCall.value;

  let ownerCall = poolContract.try_getOwner();
  let owner = ownerCall.value;

  let pool = handleNewPool(event, poolId, swapFee);
  pool.poolType = poolType;
  pool.poolTypeVersion = poolTypeVersion;
  pool.owner = owner;

  let tokens = getPoolTokens(poolId);
  if (tokens == null) return null;
  pool.tokensList = tokens;

  pool.save();

  handleNewPoolTokens(pool, tokens);

  return poolId.toHexString();
}

export function handlePoolCreated(event: PoolCreatedEvent): void {
  let pool = new Pool(event.params.pool.toHexString());

  pool.save();
}

export function handleNewWeightedPool(event: PoolCreated): void {
  const pool = createWeightedLikePool(event, PoolType.Weighted);
  if (pool == null) return;
  WeightedPoolTemplate.create(event.params.pool);
}

export function handleNewStablePool(event: PoolCreated): void {
  const pool = createStableLikePool(event, PoolType.Stable);
  if (pool == null) return;
  StablePoolTemplate.create(event.params.pool);
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

    _updateVault(event.block.timestamp.toI32());
  }

  return pool;
}

function _updateVault(blockTimestamp: i32) {
  let vault = findOrInitializeVault();
  vault.poolCount += 1;
  vault.save();

  let vaultSnapshot = getBalancerSnapshot(vault.id, blockTimestamp);
  vaultSnapshot.poolCount += 1;
  vaultSnapshot.save();
}

function handleNewPoolTokens(pool: Pool, tokens: Bytes[]): void {
  let tokensAddresses = changetype<Address[]>(tokens);

  for (let i: i32 = 0; i < tokens.length; i++) {
    let poolId = stringToBytes(pool.id);
    let assetManager = getPoolTokenManager(poolId, tokens[i]);

    if (!assetManager) continue;

    createPoolTokenEntity(pool, tokensAddresses[i], assetManager);
  }
}
