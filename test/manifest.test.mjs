import assert from 'node:assert/strict'
import fs from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const read = (name) => fs.readFileSync(join(root, name), 'utf8')
const pkg = JSON.parse(read('package.json'))

assert.equal(pkg.name, 'dsh-disk-panel')
assert.match(pkg.version, /^\d+\.\d+\.\d+$/)
assert.equal(pkg.license, 'MIT')
assert.match(pkg.repository.url, /github\.com\/guyue55\/dsh-disk-panel/)
assert.ok(pkg.description.length > 40)

// Bundle manifest: required for `dsh plugin add` and the market submission gate.
assert.equal(pkg.dsh.manifestVersion, 1)
assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
assert.deepEqual(pkg.dsh.bundle.platforms, ['darwin', 'linux'])
assert.equal(pkg.dsh.client.platform, 'web')
assert.ok(Array.isArray(pkg.dsh.client.inject) && pkg.dsh.client.inject.length >= 3)
assert.match(pkg.engines.dsh, /0\.2\.2-rc\.1/)

const patch = read('cordis.patch.yml')
assert.match(patch, /id:\s*disk-panel/)
assert.match(patch, /name:\s*dsh-disk-panel/)

for (const file of ['index.js', 'client.js', 'icon.svg', 'assets/icon-180.png', 'LICENSE', 'README.md', 'README.zh.md', 'CHANGELOG.md']) {
  assert.ok(fs.existsSync(join(root, file)), `missing ${file}`)
}
assert.equal(pkg.exports['.'], './index.js')
assert.equal(pkg.exports['./client'], './client.js')
assert.equal(pkg.exports['./icon'], './icon.svg')

const client = read('client.js')
assert.match(client, /const PANEL_ID = 'disk-panel'/)
assert.match(client, /const NS = 'disk-panel'/)

for (const locale of ['en', 'zh']) {
  const dict = JSON.parse(read(`locale/${locale}.json`))
  assert.ok(dict.meta.title.length > 0)
  assert.ok(dict.meta.description.length > 20)
}

console.log('manifest checks passed')
