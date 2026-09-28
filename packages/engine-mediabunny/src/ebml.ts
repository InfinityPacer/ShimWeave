/** Matroska 探测共用的最小 EBML 读取工具，只解析已在内存中的字节，越界或未知长度一律按缺失处理。 */

export interface RangeReader {
  read(start: number, end: number): Promise<Uint8Array>;
}

export interface ElementHeader {
  id: number;
  elementStart: number;
  dataStart: number;
  /** 未知长度（全 1）的元素为 undefined。 */
  dataEnd: number | undefined;
}

export interface SeekEntry {
  id: number;
  position: number;
}

const EBML_SEEK_ID = {
  seek: 0x4dbb,
  seekId: 0x53ab,
  seekPosition: 0x53ac,
} as const;

export const parseSeekEntries = (bytes: Uint8Array, seekHead: ElementHeader): SeekEntry[] => {
  if (seekHead.dataEnd === undefined) return [];
  const result: SeekEntry[] = [];
  forEachElement(bytes, seekHead.dataStart, seekHead.dataEnd, (element) => {
    if (element.id !== EBML_SEEK_ID.seek || element.dataEnd === undefined) return;
    const elementEnd = element.dataEnd;
    let id: number | undefined;
    let position: number | undefined;
    forEachElement(bytes, element.dataStart, elementEnd, (child) => {
      if (child.dataEnd === undefined || child.dataEnd > elementEnd) return;
      if (child.id === EBML_SEEK_ID.seekId) id = readUnsigned(bytes, child);
      if (child.id === EBML_SEEK_ID.seekPosition) position = readUnsigned(bytes, child);
    });
    if (id !== undefined && position !== undefined) result.push({ id, position });
  });
  return result;
};

export const findElement = (
  bytes: Uint8Array,
  start: number,
  end: number,
  id: number,
): ElementHeader | undefined => {
  let found: ElementHeader | undefined;
  forEachElement(bytes, start, end, (element) => {
    if (!found && element.id === id) found = element;
  });
  return found;
};

export const forEachElement = (
  bytes: Uint8Array,
  start: number,
  end: number,
  visit: (element: ElementHeader) => void,
): void => {
  let offset = start;
  while (offset < end) {
    const element = readElementHeader(bytes, offset);
    if (!element || element.dataStart > end) return;
    visit(element);
    if (element.dataEnd === undefined || element.dataEnd <= offset || element.dataEnd > end) return;
    offset = element.dataEnd;
  }
};

export const readElementHeader = (bytes: Uint8Array, offset: number): ElementHeader | undefined => {
  const id = readVint(bytes, offset, true);
  if (!id) return undefined;
  const size = readVint(bytes, offset + id.length, false);
  if (!size) return undefined;
  const dataStart = offset + id.length + size.length;
  const dataEnd = size.value === undefined ? undefined : dataStart + size.value;
  if (dataStart > bytes.length || (dataEnd !== undefined && !Number.isSafeInteger(dataEnd))) {
    return undefined;
  }
  return { id: id.value ?? 0, elementStart: offset, dataStart, dataEnd };
};

export const readVint = (
  bytes: Uint8Array,
  offset: number,
  keepMarker: boolean,
): { value: number | undefined; length: number } | undefined => {
  const first = bytes[offset];
  if (first === undefined || first === 0) return undefined;
  let length = 1;
  let marker = 0x80;
  while ((first & marker) === 0) {
    marker >>= 1;
    length++;
  }
  if (length > 8 || offset + length > bytes.length) return undefined;
  let value = keepMarker ? first : first & (marker - 1);
  let unknown = !keepMarker && value === marker - 1;
  for (let index = 1; index < length; index++) {
    const byte = bytes[offset + index];
    if (byte === undefined) return undefined;
    value = value * 256 + byte;
    unknown &&= byte === 0xff;
  }
  return { value: unknown ? undefined : value, length };
};

export const readUnsigned = (bytes: Uint8Array, element: ElementHeader): number | undefined => {
  if (element.dataEnd === undefined || element.dataEnd - element.dataStart > 8) return undefined;
  let value = 0;
  for (let offset = element.dataStart; offset < element.dataEnd; offset++) {
    const byte = bytes[offset];
    if (byte === undefined) return undefined;
    value = value * 256 + byte;
  }
  return Number.isSafeInteger(value) ? value : undefined;
};

export const readFloat = (bytes: Uint8Array, element: ElementHeader): number | undefined => {
  if (element.dataEnd === undefined) return undefined;
  const length = element.dataEnd - element.dataStart;
  if (length !== 4 && length !== 8) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset + element.dataStart, length);
  const value = length === 4 ? view.getFloat32(0) : view.getFloat64(0);
  return Number.isFinite(value) ? value : undefined;
};

export const readAscii = (bytes: Uint8Array, element: ElementHeader): string | undefined => {
  if (element.dataEnd === undefined) return undefined;
  let result = '';
  for (let offset = element.dataStart; offset < element.dataEnd; offset++) {
    const byte = bytes[offset];
    if (byte === undefined) return undefined;
    if (byte > 0x7f) return undefined;
    result += String.fromCharCode(byte);
  }
  return result;
};

export const readUtf8 = (bytes: Uint8Array, element: ElementHeader): string | undefined => {
  if (element.dataEnd === undefined || element.dataEnd > bytes.length) return undefined;
  const text = new TextDecoder('utf-8', { fatal: false }).decode(
    bytes.subarray(element.dataStart, element.dataEnd),
  );
  return text.replace(/\0+$/, '');
};
