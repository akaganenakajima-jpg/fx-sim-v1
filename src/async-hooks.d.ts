// Workers nodejs_compat フラグで利用可能な node:async_hooks の型宣言
// @types/node は @cloudflare/workers-types と型競合するため追加せず、
// 使用するクラスのみここで最小限定義する。
declare module 'node:async_hooks' {
  export class AsyncLocalStorage<T> {
    run<R>(store: T, callback: () => Promise<R>): Promise<R>;
    run<R>(store: T, callback: () => R): R;
    getStore(): T | undefined;
  }
}
