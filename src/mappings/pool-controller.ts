import { BigDecimal, BigInt } from "@graphprotocol/graph-ts";
import { Pool, SwapFeeUpdate } from "../../generated/schema";
import {
  SwapFeePercentageChanged,
  Transfer as TransferEvent,
  WeightedPool
} from "../../generated/templates/WeightedPool/WeightedPool";
import { ZERO_ADDRESS, ZERO_BD } from "../utils/constants";
import { createUserEntity, getPoolShare, scaleDown, tokenToDecimal } from "../utils/misc";

/************************************
 *********** POOL SHARES ************
 ************************************/

export function handleTransfer(event: TransferEvent): void {
  let poolAddress = event.address;
  // TODO - refactor so pool -> poolId doesn't require call
  let poolContract = WeightedPool.bind(poolAddress);
  let poolIdCall = poolContract.try_getPoolId();
  let poolId = poolIdCall.value.toHexString();

  let isMint = event.params.from == ZERO_ADDRESS;
  let isBurn = event.params.to == ZERO_ADDRESS;

  // Addresses needed for share id generation
  let fromAddress = event.params.from;
  let toAddress = event.params.to;

  // Create associated user entities if needed
  createUserEntity(fromAddress);
  createUserEntity(toAddress);

  let poolShareFrom = getPoolShare(poolId, fromAddress);
  let poolShareFromBalance = poolShareFrom == null ? ZERO_BD : poolShareFrom.balance;
  let poolShareTo = getPoolShare(poolId, toAddress);
  let poolShareToBalance = poolShareTo == null ? ZERO_BD : poolShareTo.balance;

  let pool = Pool.load(poolId) as Pool;
  let BPT_DECIMALS = 18;
  let transferAmount = event.params.value;

  if (isMint) {
    poolShareTo.balance = poolShareTo.balance.plus(tokenToDecimal(transferAmount, BPT_DECIMALS));
    poolShareTo.save();

    pool.totalShares = pool.totalShares.plus(tokenToDecimal(transferAmount, BPT_DECIMALS));
  } else if (isBurn) {
    poolShareFrom.balance = poolShareFrom.balance.minus(
      tokenToDecimal(transferAmount, BPT_DECIMALS)
    );
    poolShareFrom.save();

    pool.totalShares = pool.totalShares.minus(tokenToDecimal(transferAmount, BPT_DECIMALS));
  } else {
    poolShareTo.balance = poolShareTo.balance.plus(tokenToDecimal(transferAmount, BPT_DECIMALS));
    poolShareTo.save();
    poolShareFrom.balance = poolShareFrom.balance.minus(
      tokenToDecimal(transferAmount, BPT_DECIMALS)
    );
    poolShareFrom.save();
  }

  // Update holder count info
  if (
    poolShareTo !== null &&
    poolShareTo.balance.notEqual(ZERO_BD) &&
    poolShareToBalance.equals(ZERO_BD)
  ) {
    pool.holdersCount = pool.holdersCount.plus(BigInt.fromI32(1));
  }

  if (
    poolShareFrom !== null &&
    poolShareFrom.balance.equals(ZERO_BD) &&
    poolShareFromBalance.notEqual(ZERO_BD)
  ) {
    pool.holdersCount = pool.holdersCount.minus(BigInt.fromI32(1));
  }

  pool.save();
}

export function handleSwapFeePercentageChange(event: SwapFeePercentageChanged): void {
  let poolAddress = event.address;
  // TODO - refactor so pool -> poolId doesn't require call
  let poolContract = WeightedPool.bind(poolAddress);
  let poolIdCall = poolContract.try_getPoolId();
  let poolId = poolIdCall.value;
  let pool = Pool.load(poolId.toHexString()) as Pool;

  const newSwapFee = scaleDown(event.params.swapFeePercentage, 18);
  pool.swapFee = newSwapFee;
  pool.save();

  // Safe way to get unique id for static like entities
  const swapFeeUpdateID = event.transaction.hash
    .toHexString()
    .concat(event.transactionLogIndex.toString());

  createSwapFeeUpdate(
    swapFeeUpdateID,
    pool,
    event.block.timestamp.toI32(),
    event.block.timestamp,
    event.block.timestamp,
    newSwapFee,
    newSwapFee
  );
}

export function createSwapFeeUpdate(
  _id: string,
  _pool: Pool,
  _blockTimestamp: i32,
  _startTimestamp: BigInt,
  _endTimestamp: BigInt,
  _startSwapFeePercentage: BigDecimal,
  _endSwapFeePercentage: BigDecimal
): void {
  let swapFeeUpdate = new SwapFeeUpdate(_id);
  swapFeeUpdate.pool = _pool.id;
  swapFeeUpdate.scheduledTimestamp = _blockTimestamp;
  swapFeeUpdate.startTimestamp = _startTimestamp;
  swapFeeUpdate.endTimestamp = _endTimestamp;
  swapFeeUpdate.startSwapFeePercentage = _startSwapFeePercentage;
  swapFeeUpdate.endSwapFeePercentage = _endSwapFeePercentage;
  swapFeeUpdate.save();
}
