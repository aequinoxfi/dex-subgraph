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
  ZERO_ADDRESS,
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
  getPreferentialPricingAsset,
  isPricingAsset,
  swapValueInUSD,
  updateLatestPrice,
  updatePoolLiquidity,
  valueInUSD
} from "./pricing";

/************************************
 ****** DEPOSITS & WITHDRAWALS ******
 ************************************/

export function handleBalanceChange(event: PoolBalanceChanged): void {
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
    if (poolToken == null) {
      throw new Error("poolToken not found");
    }
    let exitAmount = scaleDown(amounts[i].neg(), poolToken.decimals);
    exitAmounts[i] = exitAmount;
    let tokenExitAmountInUSD = valueInUSD(exitAmount, tokenAddress);
    valueUSD = valueUSD.plus(tokenExitAmountInUSD);
  }

  exit.type = "Exit";
  exit.amounts = exitAmounts;
  exit.pool = event.params.poolId.toHexString();
  exit.user = event.params.liquidityProvider.toHexString();
  exit.timestamp = blockTimestamp;
  exit.tx = transactionHash;
  exit.valueUSD = valueUSD;
  exit.save();

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

export function handleBalanceManage(event: PoolBalanceManaged): void {
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

export function handleInternalBalanceChange(event: InternalBalanceChanged): void {
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

export function handleSwapEvent(event: SwapEvent): void {
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

  // TODO: Test this then before using and replace ugly code below after
  // let priceIn = _getTokenPrice(
  //   poolTokenIn.weight,
  //   poolTokenOut.weight,
  //   tokenAmountIn,
  //   tokenAmountOut,
  //   newInAmount,
  //   newOutAmount
  // );

  // // reverse parameter order for each
  // let priceOut = _getTokenPrice(
  //   poolTokenOut.weight,
  //   poolTokenIn.weight,
  //   tokenAmountOut,
  //   tokenAmountIn,
  //   newOutAmount,
  //   newInAmount
  // );

  // if (priceIn != null) {
  //   _saveTokenPrice(
  //     event,
  //     pool.totalLiquidity,
  //     swapValueUSD,
  //     tokenInAddress,
  //     tokenInAddress,
  //     tokenOutAddress,
  //     tokenAmountIn,
  //     tokenAmountOut,
  //     priceIn
  //   );
  // }

  // if (priceOut != null) {
  //   // reverse token order
  //   _saveTokenPrice(
  //     event,
  //     pool.totalLiquidity,
  //     swapValueUSD,
  //     tokenOutAddress,
  //     tokenOutAddress,
  //     tokenInAddress,
  //     tokenAmountOut,
  //     tokenAmountIn,
  //     priceOut
  //   );
  // }

  // Capture price
  // TODO: refactor these if statements using a helper function
  let block = event.block.number;
  let tokenInWeight = poolTokenIn.weight;
  let tokenOutWeight = poolTokenOut.weight;
  if (
    isPricingAsset(tokenInAddress) &&
    pool.totalLiquidity.gt(MIN_POOL_LIQUIDITY) &&
    swap.valueUSD.gt(MIN_SWAP_VALUE_USD)
  ) {
    let tokenPriceId = getTokenPriceId(poolId.toHex(), tokenOutAddress, tokenInAddress, block);
    let tokenPrice = new TokenPrice(tokenPriceId);
    //tokenPrice.poolTokenId = getPoolTokenId(poolId, tokenOutAddress);
    tokenPrice.poolId = poolId.toHexString();
    tokenPrice.block = block;
    tokenPrice.timestamp = blockTimestamp;
    tokenPrice.asset = tokenOutAddress;
    tokenPrice.amount = tokenAmountIn;
    tokenPrice.pricingAsset = tokenInAddress;

    if (tokenInWeight && tokenOutWeight) {
      // As the swap is with a WeightedPool, we can easily calculate the spot price between the two tokens
      // based on the pool's weights and updated balances after the swap.
      tokenPrice.price = newInAmount.div(tokenInWeight).div(newOutAmount.div(tokenOutWeight));
    } else {
      // Otherwise we can get a simple measure of the price from the ratio of amount in vs amount out
      tokenPrice.price = tokenAmountIn.div(tokenAmountOut);
    }

    tokenPrice.save();

    updateLatestPrice(tokenPrice);
  }

  if (
    isPricingAsset(tokenOutAddress) &&
    pool.totalLiquidity.gt(MIN_POOL_LIQUIDITY) &&
    swap.valueUSD.gt(MIN_SWAP_VALUE_USD)
  ) {
    let tokenPriceId = getTokenPriceId(poolId.toHex(), tokenInAddress, tokenOutAddress, block);
    let tokenPrice = new TokenPrice(tokenPriceId);
    //tokenPrice.poolTokenId = getPoolTokenId(poolId, tokenInAddress);
    tokenPrice.poolId = poolId.toHexString();
    tokenPrice.block = block;
    tokenPrice.timestamp = blockTimestamp;
    tokenPrice.asset = tokenInAddress;
    tokenPrice.amount = tokenAmountOut;
    tokenPrice.pricingAsset = tokenOutAddress;

    if (tokenInWeight && tokenOutWeight) {
      // As the swap is with a WeightedPool, we can easily calculate the spot price between the two tokens
      // based on the pool's weights and updated balances after the swap.
      tokenPrice.price = newOutAmount.div(tokenOutWeight).div(newInAmount.div(tokenInWeight));
    } else {
      // Otherwise we can get a simple measure of the price from the ratio of amount out vs amount in
      tokenPrice.price = tokenAmountOut.div(tokenAmountIn);
    }

    tokenPrice.save();

    updateLatestPrice(tokenPrice);
  }

  const preferentialToken = getPreferentialPricingAsset([tokenInAddress, tokenOutAddress]);
  if (preferentialToken != ZERO_ADDRESS) {
    addHistoricalPoolLiquidityRecord(poolId.toHex(), block, preferentialToken);
  }

  updatePoolLiquidity(poolId.toHex(), blockTimestamp);
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

function _updatePoolSwapCount(pool: Pool, swapValueUSD: BigDecimal, swapFeesUSD: BigDecimal): void {
  pool.swapsCount = pool.swapsCount.plus(BigInt.fromI32(1));
  pool.totalSwapVolume = pool.totalSwapVolume.plus(swapValueUSD);
  pool.totalSwapFee = pool.totalSwapFee.plus(swapFeesUSD);
  pool.save();
}

function _updateVaultSwapCount(
  vault: Balancer,
  swapValueUSD: BigDecimal,
  swapFeesUSD: BigDecimal
): void {
  vault.totalSwapVolume = vault.totalSwapVolume.plus(swapValueUSD);
  vault.totalSwapFee = vault.totalSwapFee.plus(swapFeesUSD);
  vault.totalSwapCount = vault.totalSwapCount.plus(BigInt.fromI32(1));
  vault.save();
}

function _doVaultSnapshot(vault: Balancer, blockTimestamp: i32): void {
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
  blockTimestamp: i32
): void {
  let tradePair = getTradePair(tokenInAddress, tokenOutAddress);
  tradePair.totalSwapVolume = tradePair.totalSwapVolume.plus(swapValueUSD);
  tradePair.totalSwapFee = tradePair.totalSwapFee.plus(swapFeesUSD);
  tradePair.save();

  let tradePairSnapshot = getTradePairSnapshot(tradePair.id, blockTimestamp);
  tradePairSnapshot.totalSwapVolume = tradePair.totalSwapVolume.plus(swapValueUSD);
  tradePairSnapshot.totalSwapFee = tradePair.totalSwapFee.plus(swapFeesUSD);
  tradePairSnapshot.save();
}

function _saveTokenPrice(
  event: SwapEvent,
  poolTotalLiquidity: BigDecimal,
  swapValueUSD: BigDecimal,
  checkAssetToken: Address,
  tokenAddressA: Address,
  tokenAddressB: Address,
  tokenAmountA: BigDecimal,
  tokenAmountB: BigDecimal,
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
      tokenAddressA,
      tokenAddressB,
      block
    );
    let tokenPrice = new TokenPrice(tokenPriceId);
    tokenPrice.poolId = event.params.poolId.toHexString();
    tokenPrice.block = block;
    tokenPrice.timestamp = event.block.timestamp.toI32();
    tokenPrice.asset = tokenAddressA == checkAssetToken ? tokenAddressB : tokenAddressA;
    tokenPrice.amount = tokenAddressA == checkAssetToken ? tokenAmountA : tokenAmountB;
    tokenPrice.pricingAsset = tokenAddressA == checkAssetToken ? tokenAddressA : tokenAddressB;
    tokenPrice.price = price;
    tokenPrice.save();

    updateLatestPrice(tokenPrice);

    return tokenPrice;
  }

  return null;
}

function _getTokenPrice(
  tokenWeightA: BigDecimal | null,
  tokenWeightB: BigDecimal | null,
  tokenAmountA: BigDecimal,
  tokenAmountB: BigDecimal,
  newAmountA: BigDecimal,
  newAmountB: BigDecimal
): BigDecimal {
  if (tokenWeightA && tokenWeightB) {
    // As the swap is with a WeightedPool, we can easily calculate the spot price between the two tokens
    // based on the pool's weights and updated balances after the swap.
    return newAmountA.div(tokenWeightA).div(newAmountB.div(tokenWeightB));
  } else {
    // Otherwise we can get a simple measure of the price from the ratio of amount in vs amount out
    return tokenAmountA.div(tokenAmountB);
  }
}
