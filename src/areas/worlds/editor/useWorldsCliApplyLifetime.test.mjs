import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import React, { act, createElement } from 'react'
import Reconciler from 'react-reconciler'
import { build } from 'esbuild'

import { useNavStore } from '../../../shared/stores/navStore.ts'
import { useWorldsCliApplyLifetime, useWorldsCliApplyUnmountCancellation } from './useWorldsCliApplyLifetime.ts'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const renderer = Reconciler({
  now: Date.now, supportsMutation: true, isPrimaryRenderer: false,
  getRootHostContext: () => null, getChildHostContext: () => null,
  prepareForCommit: () => null, resetAfterCommit: () => {},
  createInstance: (type, props) => ({ type, props, children: [] }),
  createTextInstance: (text) => ({ text }), getPublicInstance: (node) => node,
  shouldSetTextContent: () => false, finalizeInitialChildren: () => false,
  prepareUpdate: () => true, commitUpdate: (node, _payload, _type, _oldProps, props) => { node.props = props },
  commitTextUpdate: (node, _before, text) => { node.text = text },
  appendInitialChild: (parent, child) => { parent.children.push(child) },
  appendChild: (parent, child) => { parent.children.push(child) },
  appendChildToContainer: (parent, child) => { parent.children.push(child) },
  insertBefore: (parent, child, before) => { parent.children.splice(parent.children.indexOf(before), 0, child) },
  insertInContainerBefore: (parent, child, before) => { parent.children.splice(parent.children.indexOf(before), 0, child) },
  removeChild: (parent, child) => { parent.children.splice(parent.children.indexOf(child), 1) },
  removeChildFromContainer: (parent, child) => { parent.children.splice(parent.children.indexOf(child), 1) },
  clearContainer: (parent) => { parent.children.length = 0 },
  detachDeletedInstance: () => {},
  scheduleTimeout: setTimeout, cancelTimeout: clearTimeout, noTimeout: -1,
})

function findNode(parent, predicate) {
  for (const child of parent.children ?? []) {
    if (predicate(child)) return child
    const found = findNode(child, predicate)
    if (found) return found
  }
  return null
}

function textOf(node) {
  return [node.text ?? '', ...(node.children ?? []).map(textOf)].join(' ')
}

function Harness({ controller }) {
  useWorldsCliApplyLifetime(controller)
  return createElement('span', null, 'Worlds mounted')
}

function DrawerHarness({ controller }) {
  useWorldsCliApplyUnmountCancellation(controller)
  return createElement('span', null, 'Drawer mounted')
}

test('mounted Worlds lifetime issues negative cancellation on non-navigation unmount; failed ACK is uncertainty', async () => {
  const container = { children: [] }
  const root = renderer.createContainer(container, 0, null, false, null, '', console.error, null)
  let release
  const gate = new Promise((resolve) => { release = resolve })
  let cancellations = 0
  const controller = { cancelExternalCliIntents() { cancellations++; return gate } }
  const previous = useNavStore.getState().currentPage
  await useNavStore.getState().navigate('worlds')
  try {
    await act(async () => { renderer.updateContainer(createElement(Harness, { controller }), root, null, null) })
    assert.equal(container.children.length, 1)
    await act(async () => { renderer.updateContainer(null, root, null, null) })
    assert.equal(cancellations, 1, 'effect cleanup must start Main cancellation without waiting for route navigation')
    release({ ok: false, code: 'direct_unavailable' })
    await act(async () => { await Promise.resolve() })
    assert.match(useNavStore.getState().navigationError ?? '', /outcome may be uncertain/i)
    assert.equal(useNavStore.getState().currentPage, 'worlds')
  } finally {
    release({ ok: false, code: 'direct_unavailable' })
    useNavStore.getState().dismissNavigationError()
    await useNavStore.getState().navigate(previous)
  }
})

test('mounted drawer lifetime sends cancellation on conditional unmount without navigating', async () => {
  const container = { children: [] }
  const root = renderer.createContainer(container, 0, null, false, null, '', console.error, null)
  let cancellations = 0
  const controller = { cancelExternalCliIntents() { cancellations++; return Promise.resolve({ ok: true }) } }
  await act(async () => { renderer.updateContainer(createElement(DrawerHarness, { controller }), root, null, null) })
  await act(async () => { renderer.updateContainer(null, root, null, null) })
  assert.equal(cancellations, 1)
  assert.equal(useNavStore.getState().navigationError, null)
})

test('mounted sidebar keeps Worlds selected and visibly announces a failed leave ACK', async () => {
  const cache = join(process.cwd(), 'node_modules', '.cache')
  await mkdir(cache, { recursive: true })
  const directory = await mkdtemp(join(cache, `worlds-sidebar-${randomUUID()}-`))
  const outfile = join(directory, 'sidebar.mjs')
  try {
    await build({ stdin: { contents: `export { default as Sidebar } from '${process.cwd()}/src/shared/components/layout/Sidebar.tsx';\nexport { useNavStore, registerWorldsLeaveGuard } from '${process.cwd()}/src/shared/stores/navStore.ts';`,
      loader: 'tsx', resolveDir: process.cwd() }, bundle: true, alias: { '@shared': join(process.cwd(), 'src/shared') },
      external: ['react', 'react/jsx-runtime', 'zustand'], platform: 'node', format: 'esm', jsx: 'automatic', outfile, logLevel: 'silent' })
    const { Sidebar, useNavStore: sidebarNav, registerWorldsLeaveGuard: sidebarGuard } = await import(`${pathToFileURL(outfile).href}?${randomUUID()}`)
    const container = { children: [] }
    const root = renderer.createContainer(container, 0, null, false, null, '', console.error, null)
    await sidebarNav.getState().navigate('worlds')
    const unregister = sidebarGuard(async () => false)
    try {
      await act(async () => { renderer.updateContainer(createElement(Sidebar), root, null, null) })
      const generate = findNode(container, (node) => node.type === 'button' && node.props.title === 'Generate')
      assert.ok(generate)
      await act(async () => { await generate.props.onClick() })
      assert.equal(sidebarNav.getState().currentPage, 'worlds')
      const alert = findNode(container, (node) => node.props?.role === 'alert')
      assert.ok(alert, 'failed cancellation must be rendered visibly in the mounted sidebar')
      assert.match(textOf(alert), /cancellation was not verified/i)
      assert.match(sidebarNav.getState().navigationError, /cancellation was not verified/i)
    } finally {
      unregister()
      await act(async () => { renderer.updateContainer(null, root, null, null) })
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
})
