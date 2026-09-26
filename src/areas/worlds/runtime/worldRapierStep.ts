import type { WorldPhysicsFixedStep, WorldPhysicsImpulse } from './worldPhysicsProtocol.ts'

export function executeWorldPhysicsFixedSteps(
  steps: readonly WorldPhysicsFixedStep[],
  applyImpulse: (impulse: WorldPhysicsImpulse) => void,
  executeStep: (step: WorldPhysicsFixedStep, index: number) => void,
): void {
  for (const [index, step] of steps.entries()) {
    for (const impulse of step.impulses) applyImpulse(impulse)
    executeStep(step, index)
  }
}
