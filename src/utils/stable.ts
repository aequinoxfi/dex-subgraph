import { Address, BigInt } from "@graphprotocol/graph-ts";
import { Pool } from "../../generated/schema";
import { ZERO } from "./constants";
import { StablePool } from "../../generated/StablePoolFactory/StablePool";

export function updateAmpFactor(pool: Pool): void {
  let poolContract = StablePool.bind(changetype<Address>(pool.address));

  pool.amp = getAmp(poolContract);

  pool.save();
}

// TODO: allow passing MetaStablePool once AS supports union types
export function getAmp(poolContract: StablePool): BigInt {
  let ampCall = poolContract.try_getAmplificationParameter();
  let amp = ZERO;
  if (!ampCall.reverted) {
    let value = ampCall.value.value0;
    let precision = ampCall.value.value2;
    amp = value.div(precision);
  }
  return amp;
}
