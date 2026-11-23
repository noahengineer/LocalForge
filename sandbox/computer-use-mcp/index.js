#!/usr/bin/env node
// LocalForge computer-use MCP server.
// Runs inside the sandbox container and controls the agent's own X desktop (DISPLAY, default :1)
// with xdotool, taking screenshots with ImageMagick. Speaks MCP over stdio.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)
const DISPLAY = process.env.DISPLAY || ':1'
const ENV = { ...process.env, DISPLAY }
// Max width of screenshots sent to the model. Larger screens are scaled down and click
// coordinates are scaled back up, so the model always works in screenshot pixels.
const MAX_WIDTH = Number(process.env.COMPUTER_USE_MAX_WIDTH || 1280)
// 'pixels' (default): x/y are pixels in the screenshot. 'norm1000': x/y are 0..1000 relative.
const COORD_MODE = process.env.COMPUTER_USE_COORDS === 'norm1000' ? 'norm1000' : 'pixels'

async function run(cmd, args, opts = {}) {
  const { stdout } = await execFileP(cmd, args, { env: ENV, maxBuffer: 64 * 1024 * 1024, timeout: 30000, ...opts })
  return stdout
}

async function screenSize() {
  const out = await run('xdotool', ['getdisplaygeometry'])
  const [w, h] = out.trim().split(/\s+/).map(Number)
  return { w, h }
}

let lastShot = null // { w, h, sw, sh } screen size and screenshot size of the last capture

async function capture() {
  const { w, h } = await screenSize()
  const scale = w > MAX_WIDTH ? MAX_WIDTH / w : 1
  const sw = Math.round(w * scale)
  const sh = Math.round(h * scale)
  const args = ['-display', DISPLAY, '-window', 'root']
  if (scale !== 1) args.push('-resize', `${sw}x${sh}!`)
  args.push('png:-')
  const { stdout } = await execFileP('import', args, { env: ENV, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: 30000 })
  lastShot = { w, h, sw, sh }
  return { png: stdout, w, h, sw, sh }
}

/** Convert model coordinates to screen pixels. */
async function toScreen(x, y) {
  const shot = lastShot ?? (await (async () => {
    const { w, h } = await screenSize()
    const scale = w > MAX_WIDTH ? MAX_WIDTH / w : 1
    return { w, h, sw: Math.round(w * scale), sh: Math.round(h * scale) }
  })())
  let sx, sy
  if (COORD_MODE === 'norm1000') {
    sx = (x / 1000) * shot.w
    sy = (y / 1000) * shot.h
  } else {
    sx = x * (shot.w / shot.sw)
    sy = y * (shot.h / shot.sh)
  }
  sx = Math.max(0, Math.min(shot.w - 1, Math.round(sx)))
  sy = Math.max(0, Math.min(shot.h - 1, Math.round(sy)))
  return { sx, sy }
}

const coordHelp =
  COORD_MODE === 'norm1000'
    ? 'x and y are relative coordinates from 0 to 1000 (0,0 = top-left, 1000,1000 = bottom-right of the screen).'
    : 'x and y are pixel coordinates in the most recent screenshot image (0,0 = top-left).'

const text = (t) => ({ content: [{ type: 'text', text: t }] })
const BUTTONS = { left: '1', middle: '2', right: '3' }

const server = new McpServer({ name: 'computer', version: '1.0.0' })

server.registerTool(
  'screenshot',
  {
    title: 'Screenshot',
    description:
      "Take a screenshot of the agent's own Linux desktop (XFCE on a virtual display) and return it as an image. Use it to see GUI apps you launched, then interact with click/type/key/scroll. " +
      coordHelp,
    inputSchema: {},
  },
  async () => {
    const { png, w, h, sw, sh } = await capture()
    let pointer = ''
    try {
      const loc = await run('xdotool', ['getmouselocation', '--shell'])
      const mx = /X=(\d+)/.exec(loc)?.[1]
      const my = /Y=(\d+)/.exec(loc)?.[1]
      if (mx && my) pointer = ` Mouse pointer at screen pixel (${mx}, ${my}).`
    } catch {}
    return {
      content: [
        { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
        {
          type: 'text',
          text: `Screenshot of the desktop: screen ${w}x${h} pixels, image ${sw}x${sh} pixels.${pointer} ${coordHelp}`,
        },
      ],
    }
  },
)

const xy = {
  x: z.number().describe('X coordinate. ' + coordHelp),
  y: z.number().describe('Y coordinate. ' + coordHelp),
}

server.registerTool(
  'click',
  {
    title: 'Click',
    description: 'Move the mouse to (x, y) and click. ' + coordHelp,
    inputSchema: { ...xy, button: z.enum(['left', 'middle', 'right']).optional().describe('Mouse button, default left') },
  },
  async ({ x, y, button }) => {
    const { sx, sy } = await toScreen(x, y)
    await run('xdotool', ['mousemove', '--sync', String(sx), String(sy), 'click', BUTTONS[button ?? 'left']])
    return text(`Clicked ${button ?? 'left'} at (${x}, ${y}) -> screen (${sx}, ${sy}).`)
  },
)

server.registerTool(
  'double_click',
  {
    title: 'Double click',
    description: 'Move the mouse to (x, y) and double-click the left button. ' + coordHelp,
    inputSchema: xy,
  },
  async ({ x, y }) => {
    const { sx, sy } = await toScreen(x, y)
    await run('xdotool', ['mousemove', '--sync', String(sx), String(sy), 'click', '--repeat', '2', '--delay', '80', '1'])
    return text(`Double-clicked at (${x}, ${y}) -> screen (${sx}, ${sy}).`)
  },
)

server.registerTool(
  'move',
  {
    title: 'Move mouse',
    description: 'Move the mouse pointer to (x, y) without clicking (e.g. to hover). ' + coordHelp,
    inputSchema: xy,
  },
  async ({ x, y }) => {
    const { sx, sy } = await toScreen(x, y)
    await run('xdotool', ['mousemove', '--sync', String(sx), String(sy)])
    return text(`Moved mouse to (${x}, ${y}) -> screen (${sx}, ${sy}).`)
  },
)

server.registerTool(
  'type',
  {
    title: 'Type text',
    description: 'Type text with the keyboard into the focused window. Use key for special keys like Enter.',
    inputSchema: { text: z.string().describe('Text to type') },
  },
  async ({ text: t }) => {
    await run('xdotool', ['type', '--delay', '15', '--', t])
    return text(`Typed ${t.length} characters.`)
  },
)

server.registerTool(
  'key',
  {
    title: 'Press keys',
    description:
      'Press a key or key combination, xdotool syntax. Examples: "Return", "Escape", "Tab", "ctrl+s", "ctrl+shift+t", "alt+F4", "super". Several combos separated by spaces are pressed in sequence.',
    inputSchema: { keys: z.string().describe('Key combo(s), e.g. "ctrl+s" or "Down Down Return"') },
  },
  async ({ keys }) => {
    const combos = keys.trim().split(/\s+/).filter(Boolean)
    await run('xdotool', ['key', '--delay', '60', '--', ...combos])
    return text(`Pressed ${combos.join(' ')}.`)
  },
)

server.registerTool(
  'scroll',
  {
    title: 'Scroll',
    description: 'Scroll the mouse wheel at (x, y). ' + coordHelp,
    inputSchema: {
      ...xy,
      direction: z.enum(['up', 'down', 'left', 'right']).describe('Scroll direction'),
      amount: z.number().int().min(1).max(30).optional().describe('Number of wheel clicks, default 3'),
    },
  },
  async ({ x, y, direction, amount }) => {
    const { sx, sy } = await toScreen(x, y)
    const btn = { up: '4', down: '5', left: '6', right: '7' }[direction]
    const n = amount ?? 3
    await run('xdotool', ['mousemove', '--sync', String(sx), String(sy), 'click', '--repeat', String(n), '--delay', '40', btn])
    return text(`Scrolled ${direction} ${n} at (${x}, ${y}).`)
  },
)

server.registerTool(
  'launch_app',
  {
    title: 'Launch app',
    description:
      'Launch a GUI application or command on the desktop in the background (it keeps running). Examples: "xfce4-terminal", "mousepad notes.txt", "./build/myapp", "chromium http://localhost:5173". The working directory is /workspace unless cwd is given. Take a screenshot afterwards to see it.',
    inputSchema: {
      command: z.string().describe('Shell command line to run'),
      cwd: z.string().optional().describe('Working directory, default /workspace'),
    },
  },
  async ({ command, cwd }) => {
    const child = spawn('bash', ['-lc', command], {
      cwd: cwd || '/workspace',
      env: ENV,
      detached: true,
      stdio: 'ignore',
    })
    child.unref()
    await new Promise((r) => setTimeout(r, 1500))
    return text(`Launched (pid ${child.pid}): ${command}. Take a screenshot to see the result.`)
  },
)

server.registerTool(
  'wait',
  {
    title: 'Wait',
    description: 'Wait for a number of seconds (e.g. for an app to start), then continue.',
    inputSchema: { seconds: z.number().min(0.1).max(60).describe('Seconds to wait') },
  },
  async ({ seconds }) => {
    await new Promise((r) => setTimeout(r, seconds * 1000))
    return text(`Waited ${seconds}s.`)
  },
)

await server.connect(new StdioServerTransport())
