/** Keep opaque browser attestation fields intact when updating a SABR request. */
type Field = { number: number; raw: Uint8Array; payload?: Uint8Array };
function fields(bytes: Uint8Array): Field[] {
  let at = 0;
  const out: Field[] = [];
  const integer = () => {
    let n = 0,
      factor = 1;
    for (let i = 0; i < 10; i++) {
      const v = bytes[at++];
      if (v === undefined) throw new Error('SABR 请求字段不完整');
      n += (v & 127) * factor;
      if (!(v & 128)) return n;
      factor *= 128;
    }
    throw new Error('SABR 请求字段过长');
  };
  while (at < bytes.length) {
    const start = at,
      tag = integer(),
      number = Math.floor(tag / 8),
      wire = tag % 8;
    let payload: Uint8Array | undefined;
    if (!number) throw new Error('SABR 请求字段无效');
    if (wire === 0) integer();
    else if (wire === 1) at += 8;
    else if (wire === 5) at += 4;
    else if (wire === 2) {
      const length = integer();
      payload = bytes.subarray(at, at + length);
      at += length;
    } else throw new Error('不支持的 SABR 请求字段');
    if (at > bytes.length) throw new Error('SABR 请求字段越界');
    out.push({ number, raw: bytes.subarray(start, at), payload });
  }
  return out;
}
function join(parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
function integer(n: number) {
  const out = [];
  do {
    const value = n % 128;
    n = Math.floor(n / 128);
    out.push(value + (n ? 128 : 0));
  } while (n);
  return new Uint8Array(out);
}
function message(number: number, payload: Uint8Array) {
  return join([integer(number * 8 + 2), integer(payload.length), payload]);
}
export function preserveSabrContext(
  native: Uint8Array,
  generated: Uint8Array,
): Uint8Array<ArrayBuffer> {
  const original = fields(native),
    fresh = fields(generated);
  const originalContext = original.find((f) => f.number === 19)?.payload,
    freshContext = fresh.find((f) => f.number === 19)?.payload;
  if (!originalContext || !freshContext)
    throw new Error('SABR 请求缺少播放器上下文');
  const oldFields = fields(originalContext),
    newFields = fields(freshContext);
  // Preserve client info and attestation bytes, including fields not described
  // by the public schema. Only update continuation cookies and SABR contexts.
  const replace = new Set(
    [3, 5, 6].filter((n) => newFields.some((f) => f.number === n)),
  );
  const context = join([
    ...oldFields.filter((f) => !replace.has(f.number)).map((f) => f.raw),
    ...newFields.filter((f) => replace.has(f.number)).map((f) => f.raw),
  ]);
  return join([
    ...fresh.filter((f) => f.number !== 19).map((f) => f.raw),
    message(19, context),
    ...original
      .filter(
        (f) =>
          f.number > 25 &&
          f.number !== 1000 &&
          !fresh.some((g) => g.number === f.number),
      )
      .map((f) => f.raw),
  ]);
}
