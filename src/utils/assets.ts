// This file is automatically generated and contains assets from mainnet.
// Generate for other networks by running: yarn generate-assets [network].
// Supported networks are: arbitrum, goerli, mainnet, and polygon.

import { Address } from "@graphprotocol/graph-ts";

class Assets {
  public stableAssets: Address[];
  public pricingAssets: Address[];
}

export const BUSD_ADDRESS = Address.fromString("0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56");
export const USDC_ADDRESS = Address.fromString("0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d");
export const DAI_ADDRESS = Address.fromString("0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3");
export const USDT_ADDRESS = Address.fromString("0x55d398326f99059fF775485246999027B3197955");

export const assets: Assets = {
  stableAssets: [
    Address.fromString("0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56"), // BUSD
    Address.fromString("0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d"), // USDC
    Address.fromString("0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3"), // DAI
    Address.fromString("0x55d398326f99059fF775485246999027B3197955") // USDT
  ],
  pricingAssets: [
    Address.fromString("0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c"), // WETH(WBNB)
    // Address.fromString("0x804CdB9116a10bB78768D3252355a1b18067bF8f"), // bb-a-DAI-V1
    // Address.fromString("0x9210F1204b5a24742Eba12f710636D76240dF3d0"), // bb-a-USDC-V1
    // Address.fromString("0x2BBf681cC4eb09218BEe85EA2a5d3D13Fa40fC0C"), // bb-a-USDT-V1
    // Address.fromString("0xae37D54Ae477268B9997d4161B96b8200755935c"), // bb-a-DAI-V2
    // Address.fromString("0x82698aeCc9E28e9Bb27608Bd52cF57f704BD1B83"), // bb-a-USDC-V2
    // Address.fromString("0x2F4eb100552ef93840d5aDC30560E5513DFfFACb"), // bb-a-USDT-V2
    Address.fromString("0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c"), // WBTC
    Address.fromString("0x0dDef12012eD645f12AEb1B845Cb5ad61C7423F5"), // BAL
    // Address.fromString("0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2"), // MKR
    // Address.fromString("0x6810e776880C02933D47DB1b9fc05908e5386b96"), // GNO
    Address.fromString("0x5c6ee304399dbdb9c8ef030ab642b10820db8f56") // B-80BAL-20WETH
    // Address.fromString("0x7D1AfA7B718fb893dB30A3aBc0Cfc608AaCfeBB0"), // MATIC
    // Address.fromString("0xA13a9247ea42D743238089903570127DdA72fE44") // bb-a-USD
  ]
};
