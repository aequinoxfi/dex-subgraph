import { newMockEvent } from "matchstick-as"
import { ethereum, Address } from "@graphprotocol/graph-ts"
import {
  FactoryDisabled,
  PoolCreated
} from "../generated/WeightedPoolNoAMFactory/WeightedPoolNoAMFactory"

export function createFactoryDisabledEvent(): FactoryDisabled {
  let factoryDisabledEvent = changetype<FactoryDisabled>(newMockEvent())

  factoryDisabledEvent.parameters = new Array()

  return factoryDisabledEvent
}

export function createPoolCreatedEvent(pool: Address): PoolCreated {
  let poolCreatedEvent = changetype<PoolCreated>(newMockEvent())

  poolCreatedEvent.parameters = new Array()

  poolCreatedEvent.parameters.push(
    new ethereum.EventParam("pool", ethereum.Value.fromAddress(pool))
  )

  return poolCreatedEvent
}
