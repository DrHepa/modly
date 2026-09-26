import type { WorldInputAction, WorldInputDevice, WorldVector2 } from '../core/worldModel.ts'

export type WorldRuntimeInputValue = number | WorldVector2

export interface WorldRuntimeInputActionState {
  value: WorldRuntimeInputValue
  held: boolean
  pressed: boolean
  released: boolean
}

export interface WorldRuntimeInputFrame {
  sequence: number
  actions: Readonly<Record<string, WorldRuntimeInputActionState>>
}

interface GamepadLike {
  buttons: readonly { value: number; pressed?: boolean }[]
  axes: readonly number[]
}

export class WorldInputSampler {
  private readonly actions: readonly WorldInputAction[]
  private readonly controls = new Map<string, number>()
  private readonly previousHeld = new Map<string, boolean>()
  private readonly transientControls = new Set<string>()
  private sequence = 0
  private detach: (() => void) | null = null
  private readonly getGamepads: () => readonly (GamepadLike | null)[]

  constructor(actions: readonly WorldInputAction[], options: { getGamepads?: () => readonly (GamepadLike | null)[] } = {}) {
    this.actions = structuredClone(actions)
    this.getGamepads = options.getGamepads ?? (() => [])
  }

  setControl(device: WorldInputDevice, control: string, value: number, transient = false): void {
    if (!Number.isFinite(value)) throw new TypeError('Input control value must be finite.')
    const key = controlKey(device, control)
    if (value === 0) this.controls.delete(key)
    else this.controls.set(key, value)
    if (transient) this.transientControls.add(key)
  }

  sample(): WorldRuntimeInputFrame {
    const gamepads = this.getGamepads()
    const states: Record<string, WorldRuntimeInputActionState> = Object.create(null)
    for (const action of this.actions) {
      const value = this.resolveActionValue(action, gamepads)
      const held = typeof value === 'number' ? Math.abs(value) > 1e-6 : Math.hypot(value[0], value[1]) > 1e-6
      const previous = this.previousHeld.get(action.id) ?? false
      states[action.id] = Object.freeze({
        value: Array.isArray(value) ? Object.freeze([...value]) as WorldVector2 : value,
        held,
        pressed: held && !previous,
        released: !held && previous,
      })
      this.previousHeld.set(action.id, held)
    }
    for (const key of this.transientControls) this.controls.delete(key)
    this.transientControls.clear()
    this.sequence += 1
    return Object.freeze({ sequence: this.sequence, actions: Object.freeze(states) })
  }

  clear(): void {
    this.controls.clear()
    this.transientControls.clear()
  }

  attach(element: HTMLElement): () => void {
    this.detach?.()
    const keyDown = (event: KeyboardEvent) => {
      this.setControl('keyboard', event.code, 1)
      if (event.key !== event.code) this.setControl('keyboard', event.key, 1)
    }
    const keyUp = (event: KeyboardEvent) => {
      this.setControl('keyboard', event.code, 0)
      if (event.key !== event.code) this.setControl('keyboard', event.key, 0)
    }
    const pointerDown = (event: PointerEvent) => this.setControl('mouse', `Button${event.button}`, 1)
    const pointerUp = (event: PointerEvent) => this.setControl('mouse', `Button${event.button}`, 0)
    const pointerMove = (event: PointerEvent) => {
      this.setControl('mouse', 'PointerX', event.movementX, true)
      this.setControl('mouse', 'PointerY', event.movementY, true)
    }
    const wheel = (event: WheelEvent) => {
      this.setControl('mouse', 'WheelX', event.deltaX, true)
      this.setControl('mouse', 'WheelY', event.deltaY, true)
    }
    const blur = () => this.clear()
    element.addEventListener('keydown', keyDown)
    element.addEventListener('keyup', keyUp)
    element.addEventListener('pointerdown', pointerDown)
    element.addEventListener('pointerup', pointerUp)
    element.addEventListener('pointercancel', pointerUp)
    element.addEventListener('pointermove', pointerMove)
    element.addEventListener('wheel', wheel, { passive: true })
    element.addEventListener('blur', blur)
    const cleanup = () => {
      element.removeEventListener('keydown', keyDown)
      element.removeEventListener('keyup', keyUp)
      element.removeEventListener('pointerdown', pointerDown)
      element.removeEventListener('pointerup', pointerUp)
      element.removeEventListener('pointercancel', pointerUp)
      element.removeEventListener('pointermove', pointerMove)
      element.removeEventListener('wheel', wheel)
      element.removeEventListener('blur', blur)
      this.clear()
      if (this.detach === cleanup) this.detach = null
    }
    this.detach = cleanup
    return cleanup
  }

  dispose(): void {
    this.detach?.()
    this.detach = null
    this.clear()
  }

  private resolveActionValue(action: WorldInputAction, gamepads: readonly (GamepadLike | null)[]): WorldRuntimeInputValue {
    if (action.valueType === 'axis2d') {
      const value: WorldVector2 = [0, 0]
      for (const binding of action.bindings) {
        if (binding.kind !== 'axis2d') continue
        const amount = resolveBindingControl(binding.device, binding.control, this.controls, gamepads) * (binding.scale ?? 1)
        value[binding.targetAxis === 'x' ? 0 : 1] += amount
      }
      return [clampAxis(value[0]), clampAxis(value[1])]
    }
    let value = 0
    for (const binding of action.bindings) {
      if (binding.kind !== action.valueType) continue
      value += resolveBindingControl(binding.device, binding.control, this.controls, gamepads) * (binding.scale ?? 1)
    }
    return action.valueType === 'button' ? (Math.abs(value) > 1e-6 ? 1 : 0) : clampAxis(value)
  }
}

export function emptyWorldInputFrame(sequence = 0): WorldRuntimeInputFrame {
  return Object.freeze({ sequence, actions: Object.freeze(Object.create(null) as Record<string, WorldRuntimeInputActionState>) })
}

function resolveBindingControl(device: WorldInputDevice, control: string, controls: ReadonlyMap<string, number>, gamepads: readonly (GamepadLike | null)[]): number {
  if (device !== 'gamepad') return controls.get(controlKey(device, control)) ?? 0
  const gamepad = gamepads.find((candidate): candidate is GamepadLike => candidate !== null)
  if (!gamepad) return 0
  const button = /^Button(\d+)$/.exec(control)
  if (button) return gamepad.buttons[Number(button[1])]?.value ?? 0
  const axis = /^Axis(\d+)$/.exec(control)
  if (axis) return gamepad.axes[Number(axis[1])] ?? 0
  return 0
}

function controlKey(device: WorldInputDevice, control: string): string {
  return `${device}:${control}`
}

function clampAxis(value: number): number {
  return Math.max(-1, Math.min(1, value))
}
