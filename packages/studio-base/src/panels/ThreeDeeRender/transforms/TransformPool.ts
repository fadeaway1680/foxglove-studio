// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { Transform } from "@foxglove/studio-base/panels/ThreeDeeRender/transforms";

/**
 * An object pool for Transforms
 */
export class TransformPool {
  #transforms: Transform[] = [];
  #isDisposed = false;

  public acquire(): Transform {
    let transform = this.#transforms.pop();
    if (!transform) {
      transform = new Transform();
    }

    return transform;
  }

  public release(transform: Transform): void {
    if (!this.#isDisposed) {
      this.#transforms.push(transform);
    }
  }

  public dispose(): void {
    this.#isDisposed = true;
    this.#transforms.length = 0;
  }
}
