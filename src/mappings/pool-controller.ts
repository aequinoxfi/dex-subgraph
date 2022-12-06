import { BigDecimal, BigInt } from "@graphprotocol/graph-ts";
import { Pool, SwapFeeUpdate } from "../../generated/schema";
import {
  SwapFeePercentageChanged,
  Transfer as TransferEvent,
  WeightedPool
} from "../../generated/templates/WeightedPool/WeightedPool";
import { scaleDown } from "../utils/misc";

export function handleTransfer(event: TransferEvent): void {}

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
