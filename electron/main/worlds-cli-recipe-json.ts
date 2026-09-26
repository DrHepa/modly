import { parseWorldAiProposal, type WorldAiContext, type WorldAiProposal } from '../../src/areas/worlds/core/worldAiContract.ts'

const MAX_RECIPE_BYTES = 8 * 1024
const MAX_DEPTH = 16
const MAX_NODES = 1024

/** Check JSON tokens before JSON.parse can erase duplicate keys or overflow a number. */
export function parseStrictWorldsCliJson(json: unknown): unknown {
  if (typeof json !== 'string' || Buffer.byteLength(json, 'utf8') < 2 || Buffer.byteLength(json, 'utf8') > MAX_RECIPE_BYTES) throw new Error('invalid JSON bounds')
  let offset = 0
  let nodes = 0
  const white = () => { while (/\s/.test(json[offset] ?? '') && offset < json.length) offset++ }
  const string = (): string => {
    const start = offset++
    while (offset < json.length) {
      const char = json[offset++]
      if (char === '\\') { offset++; continue }
      if (char === '"') return JSON.parse(json.slice(start, offset)) as string
    }
    throw new Error('invalid string')
  }
  const value = (depth: number): void => {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) throw new Error('invalid depth')
    white()
    const char = json[offset]
    if (char === '{') {
      offset++; white()
      const keys = new Set<string>()
      if (json[offset] === '}') { offset++; return }
      while (offset < json.length) {
        if (json[offset] !== '"') throw new Error('invalid key')
        const key = string()
        if (keys.has(key)) throw new Error('duplicate key')
        keys.add(key)
        white(); if (json[offset++] !== ':') throw new Error('invalid colon')
        value(depth + 1); white()
        const end = json[offset++]
        if (end === '}') return
        if (end !== ',') throw new Error('invalid object')
        white()
      }
      throw new Error('invalid object')
    }
    if (char === '[') {
      offset++; white()
      if (json[offset] === ']') { offset++; return }
      while (offset < json.length) {
        value(depth + 1); white()
        const end = json[offset++]
        if (end === ']') return
        if (end !== ',') throw new Error('invalid array')
      }
      throw new Error('invalid array')
    }
    if (char === '"') { string(); return }
    if (char === 't' && json.slice(offset, offset + 4) === 'true') { offset += 4; return }
    if (char === 'f' && json.slice(offset, offset + 5) === 'false') { offset += 5; return }
    if (char === 'n' && json.slice(offset, offset + 4) === 'null') { offset += 4; return }
    const match = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y
    match.lastIndex = offset
    const number = match.exec(json)
    if (!number || !Number.isFinite(Number(number[0]))) throw new Error('invalid number')
    offset = match.lastIndex
  }
  value(0); white()
  if (offset !== json.length) throw new Error('trailing data')
  return JSON.parse(json) as unknown
}

export function parseWorldsCliRecipeJson(json: unknown, context: WorldAiContext): WorldAiProposal {
  const parsed = parseStrictWorldsCliJson(json)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).length !== 1 || !Object.hasOwn(parsed, 'commands')) throw new Error('invalid recipe envelope')
  const commands = (parsed as { commands: unknown }).commands
  if (!Array.isArray(commands) || commands.some((command) => command?.type === 'create-entity' && command.kind === 'observed-model')) throw new Error('resource recipes are not admitted')
  return parseWorldAiProposal({ type: 'world_command_proposal', context, commands })
}
