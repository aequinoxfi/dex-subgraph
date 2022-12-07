import { BigInt, BigDecimal, Address, log } from "@graphprotocol/graph-ts";
import {
  Balancer,
  JoinExit,
  ManagementOperation,
  Pool,
  PoolToken,
  Swap,
  TokenPrice,
  UserInternalBalance
} from "../../generated/schema";
import {
  InternalBalanceChanged,
  PoolBalanceChanged,
  PoolBalanceManaged,
  Swap as SwapEvent
} from "../../generated/Vault/Vault";
import { USDC_ADDRESS } from "../utils/assets";
import {
  MIN_POOL_LIQUIDITY,
  MIN_SWAP_VALUE_USD,
  SWAP_IN,
  SWAP_OUT,
  ZERO,
  ZERO_BD
} from "../utils/constants";
import {
  createUserEntity,
  getBalancerSnapshot,
  getToken,
  getTokenDecimals,
  getTokenPriceId,
  getTokenSnapshot,
  getTradePair,
  getTradePairSnapshot,
  loadPoolToken,
  scaleDown,
  tokenToDecimal,
  updateTokenBalances,
  uptickSwapsForToken
} from "../utils/misc";
import {
  hasVirtualSupply,
  isFXPool,
  isLinearPool,
  isStableLikePool,
  isVariableWeightPool,
  PoolType
} from "../utils/pool";
import { updateAmpFactor } from "../utils/stable";
import { updatePoolWeights } from "../utils/weighted";
import {
  addHistoricalPoolLiquidityRecord,
  isPricingAsset,
  swapValueInUSD,
  updateLatestPrice,
  updatePoolLiquidity,
  valueInUSD
} from "./pricing";

/************************************
 ****** DEPOSITS & WITHDRAWALS ******
 ************************************/

export function handleBalanceChange(event: PoolBalanceChanged) {
  let amounts: BigInt[] = event.params.deltas;
  if (amounts.length === 0) {
    return;
  }

  let total: BigInt = amounts.reduce<BigInt>((sum, amount) => sum.plus(amount), new BigInt(0));
  if (total.gt(ZERO)) {
    handlePoolJoined(event);
  } else {
    handlePoolExited(event);
  }
}

function handlePoolJoined(event: PoolBalanceChanged): void {
  let poolId: string = event.params.poolId.toHexString();
  let amounts: BigInt[] = event.params.deltas;
  let protocolFeeAmounts: BigInt[] = event.params.protocolFeeAmounts;
  let blockTimestamp = event.block.timestamp.toI32();
  let logIndex = event.logIndex;
  let transactionHash = event.transaction.hash;

  let pool = Pool.load(poolId);
  if (pool == null) {
    log.warning("Pool not found in handlePoolJoined: {} {}", [
      poolId,
      transactionHash.toHexString()
    ]);
    return;
  }

  let tokenAddresses = pool.tokensList;
  let joinId = transactionHash.toHexString().concat(logIndex.toString());
  let join = new JoinExit(joinId);
  join.sender = event.params.liquidityProvider;
  let joinAmounts = new Array<BigDecimal>(amounts.length);
  let valueUSD = ZERO_BD;

  for (let i: i32 = 0; i < tokenAddresses.length; i++) {
    let tokenAddress: Address = Address.fromString(tokenAddresses[i].toHexString());
    let poolToken = loadPoolToken(poolId, tokenAddress);
    if (poolToken == null) {
      throw new Error("poolToken not found");
    }
    let joinAmount = scaleDown(amounts[i], poolToken.decimals);
    joinAmounts[i] = joinAmount;
    let tokenJoinAmountInUSD = valueInUSD(joinAmount, tokenAddress);
    valueUSD = valueUSD.plus(tokenJoinAmountInUSD);
  }

  join.type = "Join";
  join.amounts = joinAmounts;
  join.pool = event.params.poolId.toHexString();
  join.user = event.params.liquidityProvider.toHexString();
  join.timestamp = blockTimestamp;
  join.tx = transactionHash;
  join.valueUSD = valueUSD;
  join.save();

  for (let i: i32 = 0; i < tokenAddresses.length; i++) {
    let tokenAddress: Address = Address.fromString(tokenAddresses[i].toHexString());
    let poolToken = loadPoolToken(poolId, tokenAddress);

    // adding initial liquidity
    if (poolToken == null) {
      throw new Error("poolToken not found");
    }
    let amountIn = amounts[i].minus(protocolFeeAmounts[i]);
    let tokenAmountIn = tokenToDecimal(amountIn, poolToken.decimals);
    let newBalance = poolToken.balance.plus(tokenAmountIn);
    poolToken.balance = newBalance;
    poolToken.save();

    let token = getToken(tokenAddress);
    const tokenTotalBalanceNotional = token.totalBalanceNotional.plus(tokenAmountIn);
    const tokenTotalBalanceUSD = valueInUSD(tokenTotalBalanceNotional, tokenAddress);
    token.totalBalanceNotional = tokenTotalBalanceNotional;
    token.totalBalanceUSD = tokenTotalBalanceUSD;
    token.save();

    let tokenSnapshot = getTokenSnapshot(tokenAddress, event);
    tokenSnapshot.totalBalanceNotional = tokenTotalBalanceNotional;
    tokenSnapshot.totalBalanceUSD = tokenTotalBalanceUSD;
    tokenSnapshot.save();
  }

  for (let i: i32 = 0; i < tokenAddresses.length; i++) {
    let tokenAddress: Address = Address.fromString(tokenAddresses[i].toHexString());
    if (isPricingAsset(tokenAddress)) {
      let success = addHistoricalPoolLiquidityRecord(poolId, event.block.number, tokenAddress);
      // Some pricing assets may not have a route back to USD yet
      // so we keep trying until we find one
      if (success) {
        break;
      }
    }
  }

  // StablePhantom and ComposableStable pools only emit the PoolBalanceChanged event
  // with a non-zero value for the BPT amount when the pool is initialized,
  // when the amount of BPT informed in the event corresponds to the "excess" BPT that was preminted
  // and therefore must be subtracted from totalShares
  if (pool.poolType == PoolType.StablePhantom || pool.poolType == PoolType.ComposableStable) {
    let preMintedBpt = ZERO_BD;
    for (let i: i32 = 0; i < tokenAddresses.length; i++) {
      if (tokenAddresses[i] == pool.address) {
        preMintedBpt = scaleDown(amounts[i], 18);
      }
    }
    pool.totalShares = pool.totalShares.minus(preMintedBpt);
    pool.save();
  }

  updatePoolLiquidity(poolId, blockTimestamp);
}

function handlePoolExited(event: PoolBalanceChanged): void {
  let poolId = event.params.poolId.toHex();
  let amounts = event.params.deltas;
  let protocolFeeAmounts: BigInt[] = event.params.protocolFeeAmounts;
  let blockTimestamp = event.block.timestamp.toI32();
  let logIndex = event.logIndex;
  let transactionHash = event.transaction.hash;

  let pool = Pool.load(poolId);
  if (pool == null) {
    log.warning("Pool not found in handlePoolExited: {} {}", [
      poolId,
      transactionHash.toHexString()
    ]);
    return;
  }

  pool.save();

  let exitId = transactionHash.toHexString().concat(logIndex.toString());
  let exit = new JoinExit(exitId);
  exit.sender = event.params.liquidityProvider;
  let exitAmounts = new Array<BigDecimal>(amounts.length);
  let valueUSD = ZERO_BD;

  let tokenAddresses = pool.tokensList;

  for (let i: i32 = 0; i < tokenAddresses.length; i++) {
    let tokenAddress: Address = Address.fromString(tokenAddresses[i].toHexString());
    let poolToken = loadPoolToken(poolId, tokenAddress);

    // adding initial liquidity
    if (poolToken == null) {
      throw new Error("poolToken not found");
    }
    let amountOut = amounts[i].minus(protocolFeeAmounts[i]).neg();
    let tokenAmountOut = tokenToDecimal(amountOut, poolToken.decimals);
    let newBalance = poolToken.balance.minus(tokenAmountOut);
    poolToken.balance = newBalance;
    poolToken.save();

    let token = getToken(tokenAddress);
    const tokenTotalBalanceNotional = token.totalBalanceNotional.minus(tokenAmountOut);
    const tokenTotalBalanceUSD = valueInUSD(tokenTotalBalanceNotional, tokenAddress);
    token.totalBalanceNotional = tokenTotalBalanceNotional;
    token.totalBalanceUSD = tokenTotalBalanceUSD;
    token.save();

    let tokenSnapshot = getTokenSnapshot(tokenAddress, event);
    tokenSnapshot.totalBalanceNotional = tokenTotalBalanceNotional;
    tokenSnapshot.totalBalanceUSD = tokenTotalBalanceUSD;
    tokenSnapshot.save();
  }

  for (let i: i32 = 0; i < tokenAddresses.length; i++) {
    let tokenAddress: Address = Address.fromString(tokenAddresses[i].toHexString());
    if (isPricingAsset(tokenAddress)) {
      let success = addHistoricalPoolLiquidityRecord(poolId, event.block.number, tokenAddress);
      // Some pricing assets may not have a route back to USD yet
      // so we keep trying until we find one
      if (success) {
        break;
      }
    }
  }

  updatePoolLiquidity(poolId, blockTimestamp);
}

/************************************
 ********** INVESTMENTS/MANAGED *************
 ************************************/

export function handleBalanceManage(event: PoolBalanceManaged) {
  let poolId = event.params.poolId;
  let pool = Pool.load(poolId.toHex());
  if (pool == null) {
    log.warning("Pool not found in handleBalanceManage: {}", [poolId.toHexString()]);
    return;
  }

  let token: Address = event.params.token;

  let cashDelta = event.params.cashDelta;
  let managedDelta = event.params.managedDelta;

  let poolToken = loadPoolToken(poolId.toHexString(), token);
  if (poolToken == null) {
    throw new Error("poolToken not found");
  }

  let cashDeltaAmount = tokenToDecimal(cashDelta, poolToken.decimals);
  let managedDeltaAmount = tokenToDecimal(managedDelta, poolToken.decimals);
  let deltaAmount = cashDeltaAmount.plus(managedDeltaAmount);

  poolToken.balance = poolToken.balance.plus(deltaAmount);
  poolToken.cashBalance = poolToken.cashBalance.plus(cashDeltaAmount);
  poolToken.managedBalance = poolToken.managedBalance.plus(managedDeltaAmount);
  poolToken.save();

  let logIndex = event.logIndex;
  let transactionHash = event.transaction.hash;
  let managementId = transactionHash.toHexString().concat(logIndex.toHexString());

  let management = new ManagementOperation(managementId);
  if (cashDeltaAmount.gt(ZERO_BD)) {
    management.type = "Deposit";
  } else if (cashDeltaAmount.lt(ZERO_BD)) {
    management.type = "Withdraw";
  } else {
    management.type = "Update";
  }
  management.poolTokenId = poolToken.id;
  management.cashDelta = cashDeltaAmount;
  management.managedDelta = managedDeltaAmount;
  management.timestamp = event.block.timestamp.toI32();
  management.save();
}

/************************************
 ******** INTERNAL BALANCES *********
 ************************************/

export function handleInternalBalanceChange(event: InternalBalanceChanged) {
  createUserEntity(event.params.user);

  let userAddress = event.params.user.toHexString();
  let token = event.params.token;
  let balanceId = userAddress.concat(token.toHexString());

  let userBalance = UserInternalBalance.load(balanceId);
  if (userBalance == null) {
    userBalance = new UserInternalBalance(balanceId);

    userBalance.userAddress = userAddress;
    userBalance.token = token;
    userBalance.balance = ZERO_BD;
  }

  let transferAmount = tokenToDecimal(event.params.delta, getTokenDecimals(token));
  userBalance.balance = userBalance.balance.plus(transferAmount);

  userBalance.save();
}

/************************************
 ************** SWAPS ***************
 ************************************/

export function handleSwapEvent(event: SwapEvent) {
  createUserEntity(event.transaction.from);
  let poolId = event.params.poolId;

  let pool = Pool.load(poolId.toHexString());
  if (pool == null) {
    log.warning("Pool not found in handleSwapEvent: {}", [poolId.toHexString()]);
    return;
  }

  if (isVariableWeightPool(pool)) {
    // Some pools' weights update over time so we need to update them after each swap
    updatePoolWeights(poolId.toHexString());
  } else if (isStableLikePool(pool)) {
    // Stablelike pools' amplification factors update over time so we need to update them after each swap
    updateAmpFactor(pool);
  }

  // Update virtual supply
  if (hasVirtualSupply(pool)) {
    if (event.params.tokenIn == pool.address) {
      pool.totalShares = pool.totalShares.minus(tokenToDecimal(event.params.amountIn, 18));
    }
    if (event.params.tokenOut == pool.address) {
      pool.totalShares = pool.totalShares.plus(tokenToDecimal(event.params.amountOut, 18));
    }
  }

  let poolAddress = pool.address;
  let tokenInAddress: Address = event.params.tokenIn;
  let tokenOutAddress: Address = event.params.tokenOut;

  let logIndex = event.logIndex;
  let transactionHash = event.transaction.hash;
  let blockTimestamp = event.block.timestamp.toI32();

  let poolTokenIn = loadPoolToken(poolId.toHexString(), tokenInAddress);
  let poolTokenOut = loadPoolToken(poolId.toHexString(), tokenOutAddress);
  if (poolTokenIn == null || poolTokenOut == null) {
    log.warning("PoolToken not found in handleSwapEvent: (tokenIn: {}), (tokenOut: {})", [
      tokenInAddress.toHexString(),
      tokenOutAddress.toHexString()
    ]);
    return;
  }

  let tokenAmountIn: BigDecimal = scaleDown(event.params.amountIn, poolTokenIn.decimals);
  let tokenAmountOut: BigDecimal = scaleDown(event.params.amountOut, poolTokenOut.decimals);

  let swapValueUSD = ZERO_BD;
  let swapFeesUSD = ZERO_BD;

  if (poolAddress != tokenInAddress && poolAddress != tokenOutAddress) {
    swapValueUSD = swapValueInUSD(tokenInAddress, tokenAmountIn, tokenOutAddress, tokenAmountOut);
    if (!isLinearPool(pool) && !isFXPool(pool)) {
      let swapFee = pool.swapFee;
      swapFeesUSD = swapValueUSD.times(swapFee);
    } else if (isFXPool(pool)) {
      // Custom logic for calculating trading fee for FXPools
      // let isTokenInBase = tokenOutAddress == USDC_ADDRESS;
      // let baseAssimilator = isTokenInBase ? poolTokenIn.assimilator : poolTokenOut.assimilator;
      // if (baseAssimilator) {
      //   let assimilatorAddress = Address.fromString(baseAssimilator.toHexString());
      //   let assimilator = BaseToUsdAssimilator.bind(assimilatorAddress);
      //   let rateRes = assimilator.try_getRate();
      //   if (!rateRes.reverted) {
      //     let baseRate = scaleDown(rateRes.value, 8);
      //     if (isTokenInBase) {
      //       // tokenIn = baseToken, fee = (amountIn * rate) - amountOut
      //       swapFeesUSD = tokenAmountIn.times(baseRate).minus(tokenAmountOut);
      //     } else {
      //       // tokenIn = USDC, fee = amountIn - (amountOut * rate)
      //       swapFeesUSD = tokenAmountIn.minus(tokenAmountOut.times(baseRate));
      //     }
      //   }
      // }
    }
  }

  // create a new swap record
  let swap: Swap = _createNewSwap(
    event,
    tokenInAddress,
    tokenOutAddress,
    poolTokenIn.symbol,
    poolTokenOut.symbol,
    tokenAmountIn,
    tokenAmountOut,
    swapValueUSD
  );

  // update pool swapsCount
  _updatePoolSwapCount(pool, swapValueUSD, swapFeesUSD);

  // update vault total swap volume
  let vault = Balancer.load("2") as Balancer;
  _updateVaultSwapCount(vault, swapValueUSD, swapFeesUSD);

  // vault snapshot
  _doVaultSnapshot(vault, blockTimestamp);

  // update pools balances for each token
  let newInAmount = poolTokenIn.balance.plus(tokenAmountIn);
  poolTokenIn.balance = newInAmount;
  poolTokenIn.save();

  let newOutAmount = poolTokenOut.balance.minus(tokenAmountOut);
  poolTokenOut.balance = newOutAmount;
  poolTokenOut.save();

  // update swap counts for token
  // updates token snapshots as well
  uptickSwapsForToken(tokenInAddress, event);
  uptickSwapsForToken(tokenOutAddress, event);

  // update volume and balances for the tokens
  // updates token snapshots as well
  updateTokenBalances(tokenInAddress, swapValueUSD, tokenAmountIn, SWAP_IN, event);
  updateTokenBalances(tokenOutAddress, swapValueUSD, tokenAmountOut, SWAP_OUT, event);

  // update totals and snapshot for the pair
  _updateTradePair(tokenInAddress, tokenOutAddress, swapValueUSD, swapFeesUSD, blockTimestamp);

  if (swap.tokenAmountOut == ZERO_BD || swap.tokenAmountIn == ZERO_BD) {
    return;
  }

  let price = _getTokenPrice(
    poolTokenIn.weight,
    poolTokenOut.weight,
    tokenAmountIn,
    tokenAmountOut,
    newInAmount,
    newOutAmount
  );

  if (price != null) {
    // _saveSwapPrice(
    //   event,
    //   pool.totalLiquidity,
    //   swapValueUSD,
    //   tokenInAddress,
    //   tokenInAddress,
    //   tokenOutAddress,
    //   tokenAmountIn,
    //   price
    // );
    // _saveSwapPrice(
    //   event,
    //   pool.totalLiquidity,
    //   swapValueUSD,
    //   tokenOutAddress,
    //   tokenInAddress,
    //   tokenOutAddress,
    //   tokenAmountIn,
    //   price
    // );
  }
}

function _createNewSwap(
  event: SwapEvent,
  tokenInAddress: Address,
  tokenOutAddress: Address,
  poolTokenInSymbol: string,
  poolTokenOutSymbol: string,
  tokenAmountIn: BigDecimal,
  tokenAmountOut: BigDecimal,
  swapValueUSD: BigDecimal
): Swap {
  let transactionHash = event.transaction.hash;
  let swapId = transactionHash.toHexString().concat(event.logIndex.toString());
  let swap = new Swap(swapId);
  swap.tokenIn = tokenInAddress;
  swap.tokenInSym = poolTokenInSymbol;
  swap.tokenAmountIn = tokenAmountIn;
  swap.tokenOut = tokenOutAddress;
  swap.tokenOutSym = poolTokenOutSymbol;
  swap.tokenAmountOut = tokenAmountOut;
  swap.valueUSD = swapValueUSD;
  swap.caller = event.transaction.from;
  swap.userAddress = event.transaction.from.toHex();
  swap.poolId = event.params.poolId.toHex();
  swap.timestamp = event.block.timestamp.toI32();
  swap.tx = transactionHash;
  swap.save();

  return swap;
}

function _updatePoolSwapCount(pool: Pool, swapValueUSD: BigDecimal, swapFeesUSD: BigDecimal) {
  pool.swapsCount = pool.swapsCount.plus(BigInt.fromI32(1));
  pool.totalSwapVolume = pool.totalSwapVolume.plus(swapValueUSD);
  pool.totalSwapFee = pool.totalSwapFee.plus(swapFeesUSD);
  pool.save();
}

function _updateVaultSwapCount(vault: Balancer, swapValueUSD: BigDecimal, swapFeesUSD: BigDecimal) {
  vault.totalSwapVolume = vault.totalSwapVolume.plus(swapValueUSD);
  vault.totalSwapFee = vault.totalSwapFee.plus(swapFeesUSD);
  vault.totalSwapCount = vault.totalSwapCount.plus(BigInt.fromI32(1));
  vault.save();
}

function _doVaultSnapshot(vault: Balancer, blockTimestamp: number) {
  let vaultSnapshot = getBalancerSnapshot(vault.id, blockTimestamp);
  vaultSnapshot.totalSwapVolume = vault.totalSwapVolume;
  vaultSnapshot.totalSwapFee = vault.totalSwapFee;
  vaultSnapshot.totalSwapCount = vault.totalSwapCount;
  vaultSnapshot.save();
}

function _updateTradePair(
  tokenInAddress: Address,
  tokenOutAddress: Address,
  swapValueUSD: BigDecimal,
  swapFeesUSD: BigDecimal,
  blockTimestamp: number
) {
  let tradePair = getTradePair(tokenInAddress, tokenOutAddress);
  tradePair.totalSwapVolume = tradePair.totalSwapVolume.plus(swapValueUSD);
  tradePair.totalSwapFee = tradePair.totalSwapFee.plus(swapFeesUSD);
  tradePair.save();

  let tradePairSnapshot = getTradePairSnapshot(tradePair.id, blockTimestamp);
  tradePairSnapshot.totalSwapVolume = tradePair.totalSwapVolume.plus(swapValueUSD);
  tradePairSnapshot.totalSwapFee = tradePair.totalSwapFee.plus(swapFeesUSD);
  tradePairSnapshot.save();
}

function _saveSwapPrice(
  event: SwapEvent,
  poolTotalLiquidity: BigDecimal,
  swapValueUSD: BigDecimal,
  tokenInAddress: Address,
  tokenOutAddress: Address,
  checkAssetToken: Address,
  tokenAmountIn: BigDecimal,
  tokenAmountOut: BigDecimal,
  price: BigDecimal
): TokenPrice | null {
  let block = event.block.number;
  if (
    isPricingAsset(checkAssetToken) &&
    poolTotalLiquidity.gt(MIN_POOL_LIQUIDITY) &&
    swapValueUSD.gt(MIN_SWAP_VALUE_USD)
  ) {
    let tokenPriceId = getTokenPriceId(
      event.params.poolId.toHex(),
      tokenOutAddress,
      tokenInAddress,
      block
    );
    let tokenPrice = new TokenPrice(tokenPriceId);
    tokenPrice.poolId = event.params.poolId.toHexString();
    tokenPrice.block = block;
    tokenPrice.timestamp = event.block.timestamp.toI32();
    tokenPrice.asset = checkAssetToken == tokenInAddress ? tokenOutAddress : tokenInAddress;
    tokenPrice.amount = tokenInAddress == checkAssetToken ? tokenAmountIn : tokenAmountOut;
    tokenPrice.pricingAsset = tokenInAddress == checkAssetToken ? tokenInAddress : tokenOutAddress;
    tokenPrice.price = price;
    tokenPrice.save();

    updateLatestPrice(tokenPrice);

    return tokenPrice;
  }

  return null;
}

function _getTokenPrice(
  tokenInWeight: BigDecimal | null,
  tokenOutWeight: BigDecimal | null,
  tokenAmountIn: BigDecimal,
  tokenAmountOut: BigDecimal,
  newInAmount: BigDecimal,
  newOutAmount: BigDecimal
): BigDecimal {
  if (tokenInWeight && tokenOutWeight) {
    // As the swap is with a WeightedPool, we can easily calculate the spot price between the two tokens
    // based on the pool's weights and updated balances after the swap.
    return newInAmount.div(tokenInWeight).div(newOutAmount.div(tokenOutWeight));
  } else {
    // Otherwise we can get a simple measure of the price from the ratio of amount in vs amount out
    return tokenAmountIn.div(tokenAmountOut);
  }
}
