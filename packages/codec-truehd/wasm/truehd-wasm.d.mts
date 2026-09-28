export interface TrueHdModule {
  HEAPU8: Uint8Array;
  HEAPF32: Float32Array;
  cwrap(
    name: string,
    returnType: 'number' | 'string' | null,
    argumentTypes: readonly 'number'[],
  ): (...args: number[]) => unknown;
  UTF8ToString(pointer: number): string;
}

declare function createTrueHdModule(options?: Record<string, unknown>): Promise<TrueHdModule>;
export default createTrueHdModule;
