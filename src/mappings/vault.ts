import {
  InternalBalanceChanged,
  PoolBalanceChanged,
  Swap as SwapEvent
} from "../../generated/Vault/Vault";

/************************************
 ****** DEPOSITS & WITHDRAWALS ******
 ************************************/

export function handleBalanceChange(event: PoolBalanceChanged) {}

export function handleBalanceManage(event: PoolBalanceChanged) {}

export function handleInternalBalanceChange(event: InternalBalanceChanged) {}

/************************************
 ************** SWAPS ***************
 ************************************/

export function handleSwapEvent(event: SwapEvent) {}
