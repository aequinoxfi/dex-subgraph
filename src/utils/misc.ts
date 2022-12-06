import { BigDecimal, Address, BigInt, ethereum, Bytes } from "@graphprotocol/graph-ts";
import {
  Balancer,
  BalancerSnapshot,
  Pool,
  PoolShare,
  PoolSnapshot,
  PoolToken,
  Token,
  TokenSnapshot,
  User
} from "../../generated/schema";
import { WeightedPool } from "../../generated/templates/WeightedPool/WeightedPool";
import { ERC20 } from "../../generated/WeightedPoolNoAMFactory/ERC20";
import { ONE_BD, ZERO, ZERO_BD } from "./constants";
import { getPoolAddress } from "./pool";

const DAY = 24 * 60 * 60;

export function scaleDown(num: BigInt, decimals: i32): BigDecimal {
  return num.divDecimal(
    BigInt.fromI32(10)
      .pow(u8(decimals))
      .toBigDecimal()
  );
}

export function getTokenDecimals(tokenAddress: Address): i32 {
  let token = ERC20.bind(tokenAddress);
  let result = token.try_decimals();

  return result.reverted ? 0 : result.value;
}

export function stringToBytes(str: string): Bytes {
  return Bytes.fromByteArray(Bytes.fromHexString(str));
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

export function createToken(tokenAddress: Address): Token {
  let erc20token = ERC20.bind(tokenAddress);
  let token = new Token(tokenAddress.toHexString());
  let name = "";
  let symbol = "";
  let decimals = 0;

  // attempt to retrieve erc20 values
  let maybeName = erc20token.try_name();
  let maybeSymbol = erc20token.try_symbol();
  let maybeDecimals = erc20token.try_decimals();

  if (!maybeName.reverted) name = maybeName.value;
  if (!maybeSymbol.reverted) symbol = maybeSymbol.value;
  if (!maybeDecimals.reverted) decimals = maybeDecimals.value;

  let pool = WeightedPool.bind(tokenAddress);
  let isPoolCall = pool.try_getPoolId();
  if (!isPoolCall.reverted) {
    let poolId = isPoolCall.value;
    token.pool = poolId.toHexString();
  }

  token.name = name;
  token.symbol = symbol;
  token.decimals = decimals;
  token.totalBalanceUSD = ZERO_BD;
  token.totalBalanceNotional = ZERO_BD;
  token.totalSwapCount = ZERO;
  token.totalVolumeUSD = ZERO_BD;
  token.totalVolumeNotional = ZERO_BD;
  token.address = tokenAddress.toHexString();
  token.save();
  return token;
}

// this will create the token entity and populate
// with erc20 values
export function getToken(tokenAddress: Address): Token {
  let token = Token.load(tokenAddress.toHexString());
  if (token == null) {
    token = createToken(tokenAddress);
  }
  return token;
}

export function getPoolTokenId(poolId: string, tokenAddress: Address): string {
  return poolId.concat("-").concat(tokenAddress.toHexString());
}

export function loadPoolToken(poolId: string, tokenAddress: Address): PoolToken | null {
  return PoolToken.load(getPoolTokenId(poolId, tokenAddress));
}

export function createPoolSnapshot(pool: Pool, timestamp: i32): void {
  let dayTimestamp = timestamp - (timestamp % DAY); // Todays Timestamp

  let poolId = pool.id;
  if (pool == null || !pool.tokensList) return;

  let snapshotId = poolId + "-" + dayTimestamp.toString();
  let snapshot = PoolSnapshot.load(snapshotId);

  if (!snapshot) {
    snapshot = new PoolSnapshot(snapshotId);
  }

  let tokens = pool.tokensList;
  let amounts = new Array<BigDecimal>(tokens.length);
  for (let i = 0; i < tokens.length; i++) {
    let token = tokens[i];
    let tokenAddress = Address.fromString(token.toHexString());
    let poolToken = loadPoolToken(poolId, tokenAddress);
    if (poolToken == null) continue;

    amounts[i] = poolToken.balance;
  }

  snapshot.pool = poolId;
  snapshot.amounts = amounts;
  snapshot.totalShares = pool.totalShares;
  snapshot.swapVolume = pool.totalSwapVolume;
  snapshot.swapFees = pool.totalSwapFee;
  snapshot.liquidity = pool.totalLiquidity;
  snapshot.swapsCount = pool.swapsCount;
  snapshot.holdersCount = pool.holdersCount;
  snapshot.timestamp = dayTimestamp;
  snapshot.save();
}

export function getTokenSnapshot(tokenAddress: Address, event: ethereum.Event): TokenSnapshot {
  let timestamp = event.block.timestamp.toI32();
  let dayID = timestamp / 86400;
  let id = tokenAddress.toHexString() + "-" + dayID.toString();
  let dayData = TokenSnapshot.load(id);

  if (dayData == null) {
    let dayStartTimestamp = dayID * 86400;
    let token = getToken(tokenAddress);
    dayData = new TokenSnapshot(id);
    dayData.timestamp = dayStartTimestamp;
    dayData.totalSwapCount = token.totalSwapCount;
    dayData.totalBalanceUSD = token.totalBalanceUSD;
    dayData.totalBalanceNotional = token.totalBalanceNotional;
    dayData.totalVolumeUSD = token.totalVolumeUSD;
    dayData.totalVolumeNotional = token.totalVolumeNotional;
    dayData.token = token.id;
    dayData.save();
  }

  return dayData;
}

export function createPoolTokenEntity(
  pool: Pool,
  tokenAddress: Address,
  assetManagerAddress: Address
): void {
  let poolTokenId = getPoolTokenId(pool.id, tokenAddress);

  let token = ERC20.bind(tokenAddress);
  let symbol = "";
  let name = "";
  let decimals = 18;

  let symbolCall = token.try_symbol();
  let nameCall = token.try_name();
  let decimalCall = token.try_decimals();

  if (symbolCall.reverted) {
    // TODO
    //const symbolBytesCall = tokenBytes.try_symbol();
    //if (!symbolBytesCall.reverted) {
    //symbol = symbolBytesCall.value.toString();
  } else {
    symbol = symbolCall.value;
  }

  if (nameCall.reverted) {
    //const nameBytesCall = tokenBytes.try_name();
    //if (!nameBytesCall.reverted) {
    //name = nameBytesCall.value.toString();
    //}
  } else {
    name = nameCall.value;
  }

  if (!decimalCall.reverted) {
    decimals = decimalCall.value;
  }

  let poolToken = new PoolToken(poolTokenId);
  // ensures token entity is created
  let _token = getToken(tokenAddress);
  poolToken.poolId = pool.id;
  poolToken.address = tokenAddress.toHexString();
  poolToken.assetManager = assetManagerAddress;
  poolToken.name = name;
  poolToken.symbol = symbol;
  poolToken.decimals = decimals;
  poolToken.balance = ZERO_BD;
  poolToken.cashBalance = ZERO_BD;
  poolToken.managedBalance = ZERO_BD;
  poolToken.priceRate = ONE_BD;
  poolToken.token = _token.id;

  // if (isComposablePool(pool)) {
  //   let poolAddress = bytesToAddress(pool.address);
  //   let poolContract = ComposableStablePool.bind(poolAddress);
  //   let isTokenExemptCall = poolContract.try_isTokenExemptFromYieldProtocolFee(tokenAddress);

  //   if (!isTokenExemptCall.reverted) {
  //     poolToken.isExemptFromYieldProtocolFee = isTokenExemptCall.value;
  //   }
  // }

  poolToken.save();
}
