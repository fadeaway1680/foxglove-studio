// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

/**
 * An object pool for reusing objects.
 */
export class ObjectPool<T> {
  #init: () => T;
  #maxCapacity: number;
  #objects: T[] = [];
  #isDisposed = false;

  public constructor(init: () => T, maxCapacity: number = 8000) {
    this.#init = init;
    this.#maxCapacity = maxCapacity;
  }

  /** Returns an object from the pool or instantiates and returns a new one if
   * there are none.
   */
  public acquire(): T {
    return this.#objects.pop() ?? this.#init();
  }

  /** Release a object back to the pool to be reused. */
  public release(obj: T): void {
    if (!this.#isDisposed && this.#objects.length < this.#maxCapacity) {
      this.#objects.push(obj);
    }
  }

  /** Disables releasing items to the pool and clears the pool array.
   * This should be called when the pool is no longer needed.
   */
  public dispose(): void {
    this.#isDisposed = true;
    this.#objects.length = 0;
  }
}
