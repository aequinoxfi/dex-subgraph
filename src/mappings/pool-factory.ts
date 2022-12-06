import { PoolCreated as PoolCreatedEvent } from "../../generated/WeightedPoolNoAMFactory/WeightedPoolNoAMFactory";
import { Pool } from "../../generated/schema";

export function handlePoolCreated(event: PoolCreatedEvent): void {
  let pool = new Pool(event.params.pool.toHexString());

  pool.save();
}
