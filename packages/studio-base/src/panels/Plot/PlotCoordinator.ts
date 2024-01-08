// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import * as Comlink from "comlink";
import EventEmitter from "eventemitter3";

import { debouncePromise } from "@foxglove/den/async";
import { filterMap } from "@foxglove/den/collection";
import { compare, toSec, subtract as subtractTime } from "@foxglove/rostime";
import { Immutable, Time } from "@foxglove/studio";
import { Bounds1D } from "@foxglove/studio-base/components/TimeBasedChart/types";
import { GlobalVariables } from "@foxglove/studio-base/hooks/useGlobalVariables";
import { PlayerState } from "@foxglove/studio-base/players/types";
import { getLineColor } from "@foxglove/studio-base/util/plotColors";

import {
  ChartRenderer,
  HoverElement,
  InteractionEvent,
  RenderAction,
  Scale,
} from "./ChartRenderer";
import type { Service } from "./ChartRenderer.worker";
import { CsvDataset, IDatasetsBuilder, Viewport } from "./builders/IDatasetsBuilder";
import { isReferenceLinePlotPathType } from "./internalTypes";
import type { PlotConfig } from "./types";

type EventTypes = {
  timeseriesBounds(bounds: Immutable<Bounds1D>): void;
};

/**
 * PlotCoordinator interfaces commands and updates between the dataset builder and the chart
 * renderer.
 */
export class PlotCoordinator extends EventEmitter<EventTypes> {
  #renderingWorker: Worker;
  #canvas: OffscreenCanvas;
  #renderer?: Promise<Comlink.RemoteObject<ChartRenderer>>;

  #datasetsBuilder: IDatasetsBuilder;

  #timeseriesBounds?: Immutable<Partial<Bounds1D>>;
  #datasetBounds: Bounds1D = { min: 0, max: 1 };

  #currentTime?: Time;

  #pendingRenderActions: Immutable<RenderAction>[] = [];

  #viewport: Viewport = {
    size: { width: 0, height: 0 },
    bounds: { x: undefined, y: undefined },
  };

  #latestXScale?: Scale;

  #queueDispatchRender = debouncePromise(async () => {
    await this.#dispatchRender();
  });

  #queueDispatchDatasets = debouncePromise(async () => {
    await this.#dispatchDatasets();
  });

  public constructor(canvas: OffscreenCanvas, builder: IDatasetsBuilder) {
    super();

    this.#datasetsBuilder = builder;
    this.#canvas = canvas;
    this.#renderingWorker = new Worker(
      // foxglove-depcheck-used: babel-plugin-transform-import-meta
      new URL("./ChartRenderer.worker", import.meta.url),
    );
  }

  public handlePlayerState(state: Immutable<PlayerState>): void {
    const activeData = state.activeData;
    if (!activeData) {
      return;
    }

    if (!this.#currentTime || compare(this.#currentTime, activeData.currentTime) !== 0) {
      this.#currentTime = activeData.currentTime;

      this.#pendingRenderActions.push({
        type: "current-time",
        seconds: toSec(subtractTime(this.#currentTime, activeData.startTime)),
      });
    }

    const datasetBounds = this.#datasetsBuilder.handlePlayerState(state);

    // fixme - logically this is easier to think about if you consider each one overriding the next
    // highest precedent value is the config xmin/max values
    // then the dataset bounds
    // then the timeseries bounds
    // then the current interaction bounds

    if (
      datasetBounds &&
      (this.#timeseriesBounds?.max == undefined || this.#timeseriesBounds.min == undefined) &&
      (datasetBounds.min !== this.#datasetBounds.min ||
        datasetBounds.max !== this.#datasetBounds.max)
    ) {
      this.#pendingRenderActions.push({
        type: "range",
        bounds: {
          min: this.#timeseriesBounds?.min ?? datasetBounds.min,
          max: this.#timeseriesBounds?.max ?? datasetBounds.max,
        },
      });
      this.#datasetBounds = datasetBounds;
    }

    this.#queueDispatchRender();
  }

  public handleConfig(config: Immutable<PlotConfig>, globalVariables: GlobalVariables): void {
    // fixme
    /*

    config.showXAxisLabels;
    config.showYAxisLabels;

    config.xAxisVal;

    config.maxXValue;
    config.minXValue;

    config.maxYValue;
    config.minYValue;
    */

    const referenceLines = filterMap(config.paths, (path, idx) => {
      if (!path.enabled || !isReferenceLinePlotPathType(path)) {
        return;
      }

      const value = +path.value;
      if (isNaN(value)) {
        return;
      }

      return {
        color: getLineColor(path.color, idx),
        value,
      };
    });

    this.#pendingRenderActions.push({
      type: "references-lines",
      referenceLines,
    });

    this.#datasetsBuilder.setConfig(config, globalVariables);
  }

  public setTimeseriesBounds(bounds: Immutable<Partial<Bounds1D>>): void {
    this.#timeseriesBounds = bounds;
    this.#pendingRenderActions.push({
      type: "range",
      bounds: {
        min: bounds.min ?? this.#datasetBounds.min,
        max: bounds.max ?? this.#datasetBounds.max,
      },
    });
    this.#queueDispatchRender();
  }

  public resetBounds(): void {
    this.#timeseriesBounds = undefined;
    this.#pendingRenderActions.push({
      type: "range",
      bounds: this.#datasetBounds,
    });
    this.#viewport.bounds.x = undefined;
    this.#viewport.bounds.y = undefined;
    this.#queueDispatchRender();
  }

  public setSize(size: { width: number; height: number }): void {
    this.#pendingRenderActions.push({
      type: "size",
      size,
    });
    this.#queueDispatchRender();
  }

  public destroy(): void {
    this.#datasetsBuilder.destroy();
    this.#renderingWorker.terminate();
  }

  public addInteractionEvent(ev: InteractionEvent): void {
    this.#pendingRenderActions.push({
      type: "event",
      event: ev,
    });
    this.#queueDispatchRender();
  }

  public setHoverValue(seconds?: number): void {
    this.#pendingRenderActions.push({
      type: "hover",
      seconds,
    });
    this.#queueDispatchRender();
  }

  /** Get the plot x value at the canvas pixel x location */
  public getXValueAtPixel(pixelX: number): number {
    if (!this.#latestXScale) {
      return -1;
    }

    const pixelRange = this.#latestXScale.right - this.#latestXScale.left;
    if (pixelRange <= 0) {
      return -1;
    }

    // Linear interpolation to place the pixelX value within min/max
    return (
      this.#latestXScale.min +
      ((pixelX - this.#latestXScale.left) / pixelRange) *
        (this.#latestXScale.max - this.#latestXScale.min)
    );
  }

  public async getElementsAtPixel(pixel: { x: number; y: number }): Promise<HoverElement[]> {
    const renderer = await this.#rendererInstance();
    return await renderer.getElementsAtPixel(pixel);
  }

  /** Get the entire data for all series */
  public async getCsvData(): Promise<CsvDataset[]> {
    return await this.#datasetsBuilder.getCsvData();
  }

  async #dispatchRender(): Promise<void> {
    const renderer = await this.#rendererInstance();

    // fixme - filter pending actions to only the last of each kind (except interaction events)
    // fixme - a single state object would do that

    const actions = this.#pendingRenderActions;
    if (actions.length > 0) {
      let haveInteractionEvents = false;
      for (const action of actions) {
        if (action.type === "size") {
          this.#viewport.size = action.size;
        } else if (action.type === "range") {
          this.#viewport.bounds.x = action.bounds;
        } else if (action.type === "event") {
          haveInteractionEvents = true;
        }
      }

      this.#pendingRenderActions = [];
      const bounds = await renderer.dispatchActions(actions);

      if (haveInteractionEvents && bounds) {
        this.#viewport.bounds = bounds;
        this.emit("timeseriesBounds", bounds.x);
      }
    }

    this.#queueDispatchDatasets();
  }

  async #dispatchDatasets(): Promise<void> {
    const datasets = await this.#datasetsBuilder.getViewportDatasets(this.#viewport);
    const renderer = await this.#rendererInstance();
    this.#latestXScale = await renderer.updateDatasets(datasets);
  }

  async #rendererInstance(): Promise<Comlink.RemoteObject<ChartRenderer>> {
    if (this.#renderer) {
      return await this.#renderer;
    }

    const remote = Comlink.wrap<Service<Comlink.RemoteObject<ChartRenderer>>>(
      this.#renderingWorker,
    );

    // Set the promise without await so init creates only one instance of renderer even if called
    // twice.
    this.#renderer = remote.init(
      Comlink.transfer(
        {
          canvas: this.#canvas,
          devicePixelRatio: window.devicePixelRatio,
        },
        [this.#canvas],
      ),
    );
    return await this.#renderer;
  }
}
