/**
 * Minimal Node.js built-in type shims.
 * The sandbox this project was built in has no npm registry access, so
 * @types/node cannot be installed. These declarations cover exactly the
 * Node APIs StayLeased uses, keeping `tsc --strict` meaningful. If @types/node
 * is available in your environment, delete this file and add it instead.
 */

declare const process: {
  env: Record<string, string | undefined>;
  argv: string[];
  cwd(): string;
  exit(code?: number): never;
  on(ev: string, fn: (...a: any[]) => void): void;
  platform: string;
  pid: number;
  hrtime: { bigint(): bigint };
  memoryUsage(): { rss: number; heapUsed: number; heapTotal: number };
  stdout: { write(s: string): boolean };
  stderr: { write(s: string): boolean };
};

declare class Buffer extends Uint8Array {
  static from(data: string, enc?: string): Buffer;
  static from(data: ArrayBuffer | Uint8Array | number[]): Buffer;
  static concat(list: Uint8Array[], totalLength?: number): Buffer;
  static alloc(size: number): Buffer;
  static byteLength(s: string | Uint8Array, enc?: string): number;
  static isBuffer(v: unknown): v is Buffer;
  toString(enc?: string, start?: number, end?: number): string;
  subarray(start?: number, end?: number): Buffer;
  slice(start?: number, end?: number): Buffer;
  indexOf(v: string | Uint8Array | number, byteOffset?: number, enc?: string): number;
  equals(b: Uint8Array): boolean;
  copy(target: Uint8Array, targetStart?: number, sourceStart?: number, sourceEnd?: number): number;
  write(s: string, offset?: number, enc?: string): number;
}

declare module 'node:http' {
  export interface IncomingMessage {
    method?: string;
    url?: string;
    statusCode?: number;
    headers: Record<string, string | string[] | undefined>;
    socket: { remoteAddress?: string };
    on(ev: 'data', fn: (chunk: Buffer) => void): IncomingMessage;
    on(ev: 'end', fn: () => void): IncomingMessage;
    on(ev: 'error', fn: (e: Error) => void): IncomingMessage;
  }
  export interface ServerResponse {
    statusCode: number;
    headersSent: boolean;
    setHeader(k: string, v: string | number | string[]): void;
    getHeader(k: string): unknown;
    writeHead(code: number, headers?: Record<string, string | number | string[]>): void;
    write(chunk: string | Uint8Array): boolean;
    end(body?: string | Uint8Array): void;
  }
  export interface Server {
    listen(port: number, host?: string, cb?: () => void): Server;
    listen(port: number, cb?: () => void): Server;
    close(cb?: (e?: Error) => void): void;
    address(): { port: number } | string | null;
  }
  export function createServer(
    handler: (req: IncomingMessage, res: ServerResponse) => void,
  ): Server;
}

declare module 'node:https' {
  import type { IncomingMessage } from 'node:http';
  export interface ClientRequest {
    on(ev: 'error', fn: (e: Error) => void): ClientRequest;
    on(ev: 'timeout', fn: () => void): ClientRequest;
    write(chunk: string | Uint8Array): boolean;
    end(cb?: () => void): void;
    destroy(e?: Error): void;
  }
  export interface RequestOptions {
    hostname?: string;
    port?: number;
    path?: string;
    method?: string;
    headers?: Record<string, string | number>;
    timeout?: number;
  }
  export function request(opts: RequestOptions, cb: (res: IncomingMessage) => void): ClientRequest;
}

declare module 'node:crypto' {
  interface Hash {
    update(d: string | Uint8Array): Hash;
    digest(enc: 'hex' | 'base64' | 'base64url'): string;
    digest(): Buffer;
  }
  export function randomBytes(n: number): Buffer;
  export function randomUUID(): string;
  export function randomInt(max: number): number;
  export function scryptSync(
    pw: string | Buffer,
    salt: string | Buffer,
    keylen: number,
    opts?: { N?: number; r?: number; p?: number },
  ): Buffer;
  export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean;
  export function createHash(alg: string): Hash;
  export function createHmac(alg: string, key: string | Uint8Array): Hash;
}

declare module 'node:fs' {
  export function readFileSync(p: string | URL): Buffer;
  export function readFileSync(p: string | URL, enc: 'utf8' | 'utf-8'): string;
  export function writeFileSync(p: string | URL, data: string | Uint8Array): void;
  export function appendFileSync(p: string | URL, data: string): void;
  export function existsSync(p: string | URL): boolean;
  export function mkdirSync(p: string, opts?: { recursive?: boolean }): void;
  export function readdirSync(p: string): string[];
  export function statSync(p: string): { size: number; mtimeMs: number; isDirectory(): boolean };
  export function rmSync(p: string, opts?: { recursive?: boolean; force?: boolean }): void;
  export function copyFileSync(src: string, dest: string): void;
  export function renameSync(src: string, dest: string): void;
}

declare module 'node:path' {
  export function join(...parts: string[]): string;
  export function resolve(...parts: string[]): string;
  export function dirname(p: string): string;
  export function basename(p: string, ext?: string): string;
  export function extname(p: string): string;
}

declare module 'node:url' {
  export function fileURLToPath(u: string | URL): string;
  export function pathToFileURL(p: string): URL;
}

declare module 'node:sqlite' {
  export interface StatementSync {
    run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
    get(...params: unknown[]): Record<string, unknown> | undefined;
    all(...params: unknown[]): Record<string, unknown>[];
  }
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}

declare module 'node:test' {
  type Done = () => void;
  type TestFn = (t?: any) => unknown | Promise<unknown>;
  export function test(name: string, fn: TestFn): void;
  export function test(name: string, opts: Record<string, unknown>, fn: TestFn): void;
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: TestFn): void;
  export function before(fn: TestFn): void;
  export function after(fn: TestFn): void;
  export function beforeEach(fn: TestFn): void;
  export function afterEach(fn: TestFn): void;
}

declare module 'node:assert/strict' {
  interface Assert {
    (value: unknown, message?: string): asserts value;
    ok(value: unknown, message?: string): asserts value;
    equal(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    match(value: string, re: RegExp, message?: string): void;
    doesNotMatch(value: string, re: RegExp, message?: string): void;
    throws(fn: () => unknown, message?: string | RegExp | Error): void;
    rejects(p: Promise<unknown> | (() => Promise<unknown>), message?: string): Promise<void>;
    fail(message?: string): never;
  }
  const assert: Assert;
  export default assert;
}

declare module 'node:child_process' {
  export interface ChildProcess {
    kill(signal?: string): boolean;
    on(ev: string, fn: (...a: any[]) => void): void;
    stdout: { on(ev: 'data', fn: (c: Buffer) => void): void } | null;
    stderr: { on(ev: 'data', fn: (c: Buffer) => void): void } | null;
    pid?: number;
    exitCode: number | null;
    killed: boolean;
  }
  export function spawn(
    cmd: string,
    args: string[],
    opts?: { env?: Record<string, string | undefined>; cwd?: string; stdio?: unknown; detached?: boolean },
  ): ChildProcess;
  export function execSync(cmd: string, opts?: Record<string, unknown>): Buffer;
}

declare module 'node:zlib' {
  export function gzipSync(data: string | Uint8Array): Buffer;
  export function gunzipSync(data: Uint8Array): Buffer;
}
