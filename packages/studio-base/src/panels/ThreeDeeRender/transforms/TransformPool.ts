// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { Transform } from "@foxglove/studio-base/panels/ThreeDeeRender/transforms";

/**
 * An object pool for Transforms
 */
export class TransformPool {
  #maxCapacity: number;
  #transforms: Transform[] = [];
  #isDisposed = false;

  public constructor(maxCapacity: number = 8000) {
    this.#maxCapacity = maxCapacity;
  }

  /** Returns a transform from the pool or instantiates and returns a new one if
   * there are none.
   */
  public acquire(): Transform {
    return this.#transforms.pop() ?? new Transform();
  }

  /** Release a transform back to the pool to be reused. */
  public release(transform: Transform): void {
    if (!this.#isDisposed && this.#transforms.length < this.#maxCapacity) {
      this.#transforms.push(transform);
    }
  }

  /** Disables releasing items to the pool and clears the pool array.
   * This should be called when the pool is no longer needed.
   */
  public dispose(): void {
    this.#isDisposed = true;
    this.#transforms.length = 0;
  }
}
