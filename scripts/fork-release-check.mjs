import assert from 'node:assert/strict'
import fs from 'node:fs'
const pkg = JSON.parse(fs.readFileSync('package.json'))
assert.equal(pkg.name, '@wulianpu/qwen-audio-agent')
assert.equal(pkg.repository.url, 'git+https://github.com/wulianpu/qwen-audio-agent.git')
assert.equal(pkg.publishConfig.registry, 'https://npm.pkg.github.com')
assert.match(pkg.version, /^\d+\.\d+\.\d+-showroom\.\d+$/)
assert.ok(fs.existsSync('web/dist/index.html'), 'Build web before packing')
console.log(`Fork release identity and build verified: ${pkg.name}@${pkg.version}`)
