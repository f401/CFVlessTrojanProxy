// subtls 的最小类型声明（只声明本项目用到的部分；实现见同目录 subtls.js）
export type ReadMode = 0 | 1;

export interface TlsConn {
  read(bytes?: number, mode?: ReadMode): Promise<Uint8Array | undefined>;
  write(data: Uint8Array): Promise<void>;
}

export class LazyReadFunctionReadQueue {
  constructor(readFn: (bytes: number, mode?: ReadMode) => Promise<Uint8Array | undefined>);
  read(bytes: number, mode?: ReadMode): Promise<Uint8Array>;
}

export class TrustedCert {
  static databaseFromPEM(pem: string | readonly string[]): Promise<unknown>;
}

export function startTls(
  host: string,
  rootCertsDatabase: unknown,
  networkRead: (bytes: number) => Promise<Uint8Array | undefined>,
  networkWrite: (data: Uint8Array) => void,
  opts?: {
    useSNI?: boolean;
    requireServerTlsExtKeyUsage?: boolean;
    requireDigitalSigKeyUsage?: boolean;
  },
): Promise<TlsConn>;
