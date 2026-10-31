/* Minimal typings for the UTIF TIFF codec (the package ships without types). */
declare module "utif" {
  export interface UtifIfd {
    width: number;
    height: number;
    [key: string]: unknown;
  }
  const UTIF: {
    decode(buffer: ArrayBuffer): UtifIfd[];
    decodeImage(buffer: ArrayBuffer, ifd: UtifIfd, ifds?: UtifIfd[]): void;
    toRGBA8(ifd: UtifIfd): Uint8Array;
    encodeImg(rgba: Uint8Array, width: number, height: number, metadata?: unknown): ArrayBuffer;
  };
  export default UTIF;
}
