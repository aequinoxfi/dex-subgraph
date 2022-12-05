import {
  FactoryDisabled as FactoryDisabledEvent,
  PoolCreated as PoolCreatedEvent
} from "../generated/WeightedPoolNoAMFactory/WeightedPoolNoAMFactory"
import { FactoryDisabled, PoolCreated } from "../generated/schema"

export function handleFactoryDisabled(event: FactoryDisabledEvent): void {
  let entity = new FactoryDisabled(
    event.transaction.hash.concatI32(event.logIndex.toI32())
  )

  entity.blockNumber = event.block.number
  entity.blockTimestamp = event.block.timestamp
  entity.transactionHash = event.transaction.hash

  entity.save()
}

export function handlePoolCreated(event: PoolCreatedEvent): void {
  let entity = new PoolCreated(
    event.transaction.hash.concatI32(event.logIndex.toI32())
  )
  entity.pool = event.params.pool

  entity.blockNumber = event.block.number
  entity.blockTimestamp = event.block.timestamp
  entity.transactionHash = event.transaction.hash

  entity.save()
}
