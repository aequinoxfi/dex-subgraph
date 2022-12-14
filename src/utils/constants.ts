import { BigDecimal, BigInt, Address, dataSource } from "@graphprotocol/graph-ts";
import { assets } from "./assets";

export let ZERO_ADDRESS = Address.fromString("0x0000000000000000000000000000000000000000");

export let ZERO = BigInt.fromI32(0);
export let ZERO_BD = BigDecimal.fromString("0");
export let ONE_BD = BigDecimal.fromString("1");
export const SWAP_IN = 0;
export const SWAP_OUT = 1;

export let MIN_POOL_LIQUIDITY = BigDecimal.fromString("2000");
export let MIN_SWAP_VALUE_USD = BigDecimal.fromString("1");

export let USD_STABLE_ASSETS = assets.stableAssets;
export let PRICING_ASSETS = assets.stableAssets.concat(assets.pricingAssets);

class AddressByNetwork {
  public mainnet: string;
  public goerli: string;
  public dev: string;
}

let network: string = dataSource.network();

let vaultAddressByNetwork: AddressByNetwork = {
  mainnet: "0xEE1c8DbfBf958484c6a4571F5FB7b99B74A54AA7",
  goerli: "0x84259CbD70aA17EB282Cb40666d2687Cd8E100AA",
  dev: "0x84259CbD70aA17EB282Cb40666d2687Cd8E100AA"
};

function forNetwork(addressByNetwork: AddressByNetwork, network: string): Address {
  if (network == "mainnet") {
    return Address.fromString(addressByNetwork.mainnet);
  } else if (network == "goerli") {
    return Address.fromString(addressByNetwork.goerli);
  } else {
    return Address.fromString(addressByNetwork.dev);
  }
}

export let VAULT_ADDRESS = forNetwork(vaultAddressByNetwork, network);
