import { HttpError } from "./api";

const MAGIC = Buffer.from("%PDF-", "latin1");

/** PDF magic may be split across stream chunks; preserve every byte for upload. */
export async function pdfChunks(source: AsyncIterator<Uint8Array>): Promise<AsyncGenerator<Uint8Array>> {
  const prefix: Uint8Array[] = [];
  const magic = Buffer.alloc(MAGIC.length);
  let copied = 0;
  while (copied < MAGIC.length) {
    const part = await source.next();
    if (part.done) break;
    const bytes = part.value;
    prefix.push(bytes);
    copied += Buffer.from(bytes.subarray(0, MAGIC.length - copied)).copy(magic, copied);
  }
  if (copied !== MAGIC.length || !magic.equals(MAGIC)) {
    throw new HttpError(415, "Only PDF files can be uploaded to cloud storage.", "unsupported_type");
  }

  return (async function* () {
    yield* prefix;
    let part = await source.next();
    while (!part.done) {
      yield part.value;
      part = await source.next();
    }
  })();
}
