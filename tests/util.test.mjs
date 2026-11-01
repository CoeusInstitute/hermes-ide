// Pure-helper tests. Node 24 strips the TypeScript types itself: `npm test`.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { fileRef, fuzzyScore, isInside, pathsFromToolArgs, rankFiles, relPath, splitLineSuffix } from '../src/util.ts'

test('fileRef emits the @file syntax Hermes expands, relative to the workspace', () => {
  assert.equal(fileRef('D:/proj/src/app.ts', 'D:/proj'), '@file:src/app.ts')
  assert.equal(fileRef('D:/proj/src/app.ts', 'd:/proj', 10, 20), '@file:src/app.ts:10-20')
  assert.equal(fileRef('D:/proj/src/app.ts', 'D:/proj', 7, 7), '@file:src/app.ts:7')
  assert.equal(fileRef('D:/My apps/x.ts', 'C:/other'), '@file:"D:/My apps/x.ts"')
  assert.equal(fileRef('D:/proj/lib', 'D:/proj', undefined, undefined, true), '@folder:lib')
})

test('paths compare case-insensitively on Windows drives only', () => {
  assert.ok(isInside('d:\\Proj\\a.ts', 'D:/proj'))
  assert.ok(!isInside('/home/Me/a', '/home/me'))
  assert.ok(!isInside('D:/projector/a', 'D:/proj'))
  assert.equal(relPath('D:/proj', 'D:/proj'), '.')
})

test('quick open ranks name hits above deep path hits', () => {
  const files = ['src/components/Button.tsx', 'docs/button-guide.md', 'src/lib/utils.ts', 'tests/b/u/t/t/o/n.txt']
  const top = rankFiles('button', files)
  assert.deepEqual(top.slice(0, 2).sort(), ['docs/button-guide.md', 'src/components/Button.tsx'])
  assert.equal(top[2], 'tests/b/u/t/t/o/n.txt')
  assert.equal(rankFiles('util', files)[0], 'src/lib/utils.ts')
  assert.ok(!top.includes('src/lib/utils.ts'))
  assert.equal(fuzzyScore('zzz', 'abc'), -1)
  assert.deepEqual(splitLineSuffix('app.ts:42:7'), { query: 'app.ts', line: 42, col: 7 })
  assert.deepEqual(splitLineSuffix(':12'), { query: '', line: 12, col: undefined })
})

test('tool arguments yield the files an agent turn may have written', () => {
  assert.deepEqual(pathsFromToolArgs({ path: 'src/a.ts', content: 'x' }), ['src/a.ts'])
  assert.deepEqual(
    pathsFromToolArgs({ patch: '*** Begin Patch\n*** Update File: src/b.ts\n@@\n-x\n+y\n*** Add File: new.md\n' }).sort(),
    ['new.md', 'src/b.ts']
  )
  assert.deepEqual(pathsFromToolArgs({ edits: [{ file_path: 'c.py' }] }), ['c.py'])
  assert.deepEqual(pathsFromToolArgs(null), [])
})
