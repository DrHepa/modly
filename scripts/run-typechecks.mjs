#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const TYPECHECK_PROJECTS = ['tsconfig.node.json', 'tsconfig.web.json', 'tsconfig.worlds-integration.json']

export async function runTypechecks(repositoryRoot = fileURLToPath(new URL('../', import.meta.url)), options = {}) {
  const root = resolve(repositoryRoot)
  const spawnProcess = options.spawnProcess ?? spawn
  const write = options.write ?? ((message) => process.stdout.write(`${message}\n`))
  let exitCode = 0

  for (const project of TYPECHECK_PROJECTS) {
    write(`[typecheck] ${project}`)
    try {
      const result = await new Promise((resolveResult, reject) => {
        const child = spawnProcess(process.execPath, [
          join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit', '-p', project,
        ], { cwd: root, env: process.env, stdio: 'inherit' })
        child.once('error', reject)
        child.once('close', (code, signal) => resolveResult({ code, signal }))
      })
      if (result.signal) write(`[typecheck] ${project} terminated by ${result.signal}`)
      if (result.code !== 0 || result.signal) {
        exitCode ||= Number.isInteger(result.code) && result.code > 0 ? result.code : 1
      }
    } catch (error) {
      write(`[typecheck] ${project} failed to start: ${error instanceof Error ? error.message : String(error)}`)
      exitCode ||= 1
    }
  }

  return exitCode
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null
if (invokedPath === import.meta.url) process.exitCode = await runTypechecks()
