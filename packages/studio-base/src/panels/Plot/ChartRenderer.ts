// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import * as Comlink from "comlink";

import { Immutable } from "@foxglove/studio";
import { MessagePipelineContext } from "@foxglove/studio-base/components/MessagePipeline";

export class ChartRenderer {
  #worker: Worker;
  //#remote: Comlink.Remote<(typeof import("./WorkerImageDecoder.worker"))["service"]>;

  public constructor(canvas: HTMLCanvasElement) {
    /*
    const offscreenCanvas =
      typeof canvas.transferControlToOffscreen === "function"
        ? canvas.transferControlToOffscreen()
        : canvas;

    // if we don't support offscreen canvas, then all the work must be done on the main thread?
    // actually we could still do all the downsample, etc on worker but then send back to main to render
    // kinda tragic :(

     const result = await this.#remove.initialize(
      Comlink.transfer(
        {
          canvas: offscreenCanvas,
          devicePixelRatio,
        },
        [offscreenCanvas],
      ),
    );
        */

    this.#worker = new Worker(
      // foxglove-depcheck-used: babel-plugin-transform-import-meta
      new URL("./ChartRenderer.worker", import.meta.url),
    );

    this.#remote = Comlink.wrap(this.#worker);

    // state initialize?
    // emit error?
  }

  public update(state: Immutable<MessagePipelineContext>): void {
    state.setSubscriptions(id, []);

    state.playerState.progress.messageCache?.blocks;
  }

  public terminate(): void {
    this.#worker.terminate();
  }
}
