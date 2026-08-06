import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const sdk = (path) => pathToFileURL(join(process.cwd(), 'node_modules/@modelcontextprotocol/sdk/dist/esm', path)).href
const { Server } = await import(sdk('server/index.js'))
const { StdioServerTransport } = await import(sdk('server/stdio.js'))
const { CallToolRequestSchema, ListToolsRequestSchema } = await import(sdk('types.js'))

const pidFile = process.argv[2]
const server = new Server({ name: 'process-tree-fixture', version: '1.0.0' }, { capabilities: { tools: {} } })
setInterval(() => undefined, 1_000)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: 'hang', inputSchema: { type: 'object', additionalProperties: false } }],
}))
server.setRequestHandler(CallToolRequestSchema, async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], { stdio: 'ignore' })
  await writeFile(pidFile, JSON.stringify({ parent: process.pid, child: child.pid }))
  return new Promise(() => undefined)
})

await server.connect(new StdioServerTransport())
