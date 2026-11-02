// The build decodes Lezer parse tables ahead of time (dev/lezer-tables.mjs). Each grammar must give
// the same parser: identical decoded tables and identical parse trees.
import assert from 'node:assert/strict'
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { decodeLezerTables } from '../dev/lezer-tables.mjs'

const modules = join(dirname(fileURLToPath(import.meta.url)), '..', 'dev', 'node_modules')

// package -> [how to reach its LR parser from the module's exports, a sample to parse]
const GRAMMARS = {
  '@lezer/javascript': [m => m.parser.configure({ dialect: 'jsx ts' }), 'export const App = (p: {n: number}) => <div className="a">{p.n ?? `x${1}`}</div>\n'],
  '@lezer/css': [m => m.parser, '.a > b:hover { color: rgb(1 2 3 / 50%); --x: calc(1px + 2em) }\n@media (min-width: 10px) { a { b: c } }\n'],
  '@lezer/html': [m => m.parser, '<!doctype html><p class=x>Hi <b>there</b><script>let a = 1</script>\n'],
  '@lezer/json': [m => m.parser, '{"a": [1, 2.5e3, true, null, {"b": "c\\n"}]}\n'],
  '@lezer/python': [m => m.parser, 'async def f(x: int = 1) -> str:\n    return f"{x!r:>4}" if x else [y async for y in g()]\n'],
  '@lezer/rust': [m => m.parser, "fn main<'a>(x: &'a str) -> Result<(), Box<dyn Error>> { let v = vec![1, 2]; println!(\"{}\", x); Ok(()) }\n"],
  '@lezer/cpp': [m => m.parser, '#include <vector>\ntemplate <typename T> auto f(T&& t) -> decltype(t) { return std::move(t); }\n'],
  '@lezer/go': [m => m.parser, 'package main\nfunc main() { ch := make(chan int); go func() { ch <- 1 }(); select { case v := <-ch: _ = v } }\n'],
  '@lezer/java': [m => m.parser, 'public class A<T> { @Override public String toString() { return switch (x) { case 1 -> "a"; default -> "b"; }; } }\n'],
  '@lezer/php': [m => m.parser, '<?php\nnamespace A; function f(?int $x = null): string { return match($x) { 1 => "a", default => "b" }; }\n'],
  '@lezer/xml': [m => m.parser, '<?xml version="1.0"?><a b="c"><![CDATA[x]]><d/><!-- e --></a>\n'],
  '@lezer/yaml': [m => m.parser, 'a: [1, 2]\nb:\n  - c: d\n    e: |\n      text\n'],
  '@codemirror/lang-yaml': [m => m.yamlLanguage.parser, 'key: value\nlist:\n  - one\n'],
  '@codemirror/lang-sql': [m => m.StandardSQL.language.parser, "SELECT a, COUNT(*) FROM t WHERE b IN ('x', 'y') GROUP BY a HAVING COUNT(*) > 1;\n"]
}

const PACKED_TABLE = /\b(?:states|stateData|goto|tokenData):\s*"/

for (const [pkg, [reach, sample]] of Object.entries(GRAMMARS)) {
  test(`decoded Lezer tables give the same parser: ${pkg}`, async () => {
    const file = join(modules, ...pkg.split('/'), 'dist', 'index.js')
    const src = readFileSync(file, 'utf8')
    const decoded = decodeLezerTables(src)
    assert.notEqual(decoded, src, 'the module has packed tables to decode')
    assert.doesNotMatch(decoded, PACKED_TABLE, 'no packed table string is left')
    // Next to the original, so its imports resolve the same way; removed afterwards.
    const twin = join(dirname(file), 'index.decoded-test.js')
    writeFileSync(twin, decoded)
    try {
      const a = reach(await import(pathToFileURL(file).href))
      const b = reach(await import(pathToFileURL(twin).href))
      for (const key of ['states', 'data', 'goto']) assert.deepEqual(Array.from(b[key]), Array.from(a[key]), key)
      assert.equal(b.parse(sample).toString(), a.parse(sample).toString())
    } finally {
      unlinkSync(twin)
    }
  })
}
