import {
  assert,
  describe,
  test,
  clearStore,
  beforeAll,
  afterAll
} from "matchstick-as/assembly/index"
import { Address } from "@graphprotocol/graph-ts"
import { FactoryDisabled } from "../generated/schema"
import { FactoryDisabled as FactoryDisabledEvent } from "../generated/WeightedPoolNoAMFactory/WeightedPoolNoAMFactory"
import { handleFactoryDisabled } from "../src/weighted-pool-no-am-factory"
import { createFactoryDisabledEvent } from "./weighted-pool-no-am-factory-utils"

// Tests structure (matchstick-as >=0.5.0)
// https://thegraph.com/docs/en/developer/matchstick/#tests-structure-0-5-0

describe("Describe entity assertions", () => {
  beforeAll(() => {
    let newFactoryDisabledEvent = createFactoryDisabledEvent()
    handleFactoryDisabled(newFactoryDisabledEvent)
  })

  afterAll(() => {
    clearStore()
  })

  // For more test scenarios, see:
  // https://thegraph.com/docs/en/developer/matchstick/#write-a-unit-test

  test("FactoryDisabled created and stored", () => {
    assert.entityCount("FactoryDisabled", 1)

    // 0xa16081f360e3847006db660bae1c6d1b2e17ec2a is the default address used in newMockEvent() function

    // More assert options:
    // https://thegraph.com/docs/en/developer/matchstick/#asserts
  })
})
