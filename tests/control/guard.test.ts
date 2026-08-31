import { expect, test } from 'bun:test'
import {
  assertControlTarget,
  ControlTargetError,
  isControlTarget,
} from '../../src/control/guard.ts'

const config = {
  CONTROL_PROVIDER: 'fake' as const,
  CONTROL_CONVERSATION_ID: 'ctrl',
}

test('accepts only the control provider + conversation pair', () => {
  expect(isControlTarget(config, { provider: 'fake', externalId: 'ctrl' })).toBe(true)
  expect(isControlTarget(config, { provider: 'fake', externalId: 'other' })).toBe(false)
  expect(isControlTarget(config, { provider: 'whatsapp', externalId: 'ctrl' })).toBe(false)
})

test('with no CONTROL_CONVERSATION_ID there is no valid destination', () => {
  expect(
    isControlTarget(
      { ...config, CONTROL_CONVERSATION_ID: undefined },
      { provider: 'fake', externalId: 'ctrl' },
    ),
  ).toBe(false)
})

test('assertControlTarget throws ControlTargetError with English message', () => {
  expect(() =>
    assertControlTarget(config, { provider: 'fake', externalId: 'other' }),
  ).toThrow(ControlTargetError)
  expect(() =>
    assertControlTarget(config, { provider: 'fake', externalId: 'other' }),
  ).toThrow('destination outside control: fake:other')
})
