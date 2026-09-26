'use strict'

const marker = Symbol.for('modly.world-ffmpeg-package.network-denied.v1')
if (!globalThis[marker]) {
  Object.defineProperty(globalThis, marker, { value: true, enumerable: false })
  const deny = () => {
    const error = new Error('Network access is disabled during audited offline packaging.')
    error.code = 'WORLD_FFMPEG_PACKAGE_NETWORK_DENIED'
    throw error
  }
  const denyCallback = (...args) => {
    const callback = args.findLast((value) => typeof value === 'function')
    if (callback) {
      const error = new Error('Network access is disabled during audited offline packaging.')
      error.code = 'WORLD_FFMPEG_PACKAGE_NETWORK_DENIED'
      queueMicrotask(() => callback(error))
      return
    }
    return deny()
  }
  for (const name of ['node:http', 'node:https']) {
    const module = require(name)
    module.request = deny
    module.get = deny
  }
  const net = require('node:net')
  net.connect = deny
  net.createConnection = deny
  require('node:tls').connect = deny
  require('node:dgram').createSocket = deny
  const dns = require('node:dns')
  for (const name of ['lookup', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'reverse']) {
    dns[name] = denyCallback
  }
  if (dns.promises) {
    for (const name of ['lookup', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'reverse']) {
      dns.promises[name] = async () => deny()
    }
  }
  globalThis.fetch = async () => deny()
}
