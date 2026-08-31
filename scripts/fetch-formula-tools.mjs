// Dev-time snapshot: fetch every official formula's tool declarations into
// formula-tools.snapshot.json. Run this when Kimi adds or changes formulas
// (e.g. quickjs / code-runner going live), then mirror the changes into
// src/formula-tools.js.
import { writeFileSync } from 'node:fs'
import { resolveApiKey } from './resolve-credential.mjs'

const apiKey = resolveApiKey()
const baseURL = process.env.KIMI_FORMULA_BASE_URL ?? 'https://api.moonshot.cn/v1'
const formulas = ['convert', 'web-search', 'rethink', 'random-choice', 'mew', 'memory', 'excel', 'date', 'base64', 'fetch', 'quickjs', 'code-runner']
const out = {}
for (const f of formulas) {
  const uri = `moonshot/${f}:latest`
  const res = await fetch(`${baseURL}/formulas/${uri}/tools`, { headers: { authorization: `Bearer ${apiKey}` } })
  out[uri] = res.ok ? await res.json() : { error: `HTTP ${res.status}`, body: (await res.text()).slice(0, 300) }
}
writeFileSync(new URL('../formula-tools.snapshot.json', import.meta.url), JSON.stringify(out, null, 2))
for (const [uri, decl] of Object.entries(out)) {
  const tools = decl.tools ?? []
  const names = tools.flatMap((t) => {
    if (t.type === 'function') return [`${t.function.name}(${Object.keys(t.function.parameters?.properties ?? {}).join(',')})`]
    if (t.type === '_plugin') return t._plugin.functions.map(fn => fn.name)
    return ['?']
  })
  console.log(uri, '→', decl.error ?? names.join('; '))
}
