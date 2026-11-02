// Build-time decoding of Lezer parse tables.
//
// Lezer grammars ship their parse tables as packed strings that LRParser decodes into typed arrays
// when the module loads. LRParser.deserialize and LocalTokenGroup accept the typed arrays
// themselves (`decodeArray` returns any non-string input unchanged), so the build decodes the
// tables ahead of time and the bundle carries plain integer arrays: the same parser data, readable
// as numbers. tests/lezer-tables.test.mjs checks every grammar's decoded tables and parse trees
// against the packages' own.

/** Lezer's own decoder, copied from @lezer/lr 1.4.12 (MIT, Marijn Haverbeke). */
export function decodeArray(input, Type = Uint16Array) {
  if (typeof input != 'string') return input
  let array = null
  for (let pos = 0, out = 0; pos < input.length; ) {
    let value = 0
    for (;;) {
      let next = input.charCodeAt(pos++),
        stop = false
      if (next == 126 /* BigValCode */) {
        value = 65535 /* BigVal */
        break
      }
      if (next >= 92 /* Gap2 */) next--
      if (next >= 34 /* Gap1 */) next--
      let digit = next - 32 /* Start */
      if (digit >= 46 /* Base */) {
        digit -= 46
        stop = true
      }
      value += digit
      if (stop) break
      value *= 46
    }
    if (array) array[out++] = value
    else array = new Type(value)
  }
  return array
}

// The table fields of a serialized parser and the typed array LRParser decodes each into.
const TABLE_TYPES = { states: Uint32Array, stateData: Uint16Array, goto: Uint16Array, tokenData: Uint16Array }
const STRING = String.raw`"(?:[^"\\\n]|\\.)*"`
const TABLE_FIELD = new RegExp(String.raw`\b(states|stateData|goto|tokenData):\s*(${STRING})`, 'g')
const LOCAL_GROUP = new RegExp(String.raw`\bnew LocalTokenGroup\((${STRING})`, 'g')

function literal(Type, packed) {
  return `new ${Type.name}([${Array.from(decodeArray(JSON.parse(packed), Type)).join(',')}])`
}

/** A grammar module's source with its packed tables replaced by the typed arrays they decode to.
 *  Sources without a serialized parser come back unchanged. */
export function decodeLezerTables(src) {
  if (!src.includes('LRParser.deserialize')) return src
  return src
    .replace(TABLE_FIELD, (_, key, packed) => `${key}: ${literal(TABLE_TYPES[key], packed)}`)
    .replace(LOCAL_GROUP, (_, packed) => `new LocalTokenGroup(${literal(Uint16Array, packed)}`)
}
