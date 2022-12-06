import { BigDecimal, BigInt, Address, dataSource } from "@graphprotocol/graph-ts";

export let ZERO_ADDRESS = Address.fromString("0x0000000000000000000000000000000000000000");

export let ZERO = BigInt.fromI32(0);
export let ZERO_BD = BigDecimal.fromString("0");
export let ONE_BD = BigDecimal.fromString("1");
