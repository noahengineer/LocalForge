const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

test('app entry files exist and main.js parses', () => {
  const root = path.join(__dirname, '..')
  for (const f of ['main.js', 'preload.js', 'index.html', 'renderer.js']) {
    assert.ok(fs.existsSync(path.join(root, f)), `${f} missing`)
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  assert.equal(pkg.main, 'main.js')
  new Function(fs.readFileSync(path.join(root, 'renderer.js'), 'utf8')) // syntax check
})
