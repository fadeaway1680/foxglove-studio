// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import * as Comlink from "comlink";
import EventEmitter from "eventemitter3";

import { debouncePromise } from "@foxglove/den/async";
import { filterMap } from "@foxglove/den/collection";
import { isTime, toSec, subtract as subtractTime, compare } from "@foxglove/rostime";
import { Immutable, Time, MessageEvent } from "@foxglove/studio";
import { RosPath } from "@foxglove/studio-base/components/MessagePathSyntax/constants";
import parseRosPath from "@foxglove/studio-base/components/MessagePathSyntax/parseRosPath";
import { simpleGetMessagePathDataItems } from "@foxglove/studio-base/components/MessagePathSyntax/simpleGetMessagePathDataItems";
import { fillInGlobalVariablesInPath } from "@foxglove/studio-base/components/MessagePathSyntax/useCachedGetMessagePathDataItems";
import { Bounds1D } from "@foxglove/studio-base/components/TimeBasedChart/types";
import { GlobalVariables } from "@foxglove/studio-base/hooks/useGlobalVariables";
import { PlayerState } from "@foxglove/studio-base/players/types";
import { getLineColor } from "@foxglove/studio-base/util/plotColors";
import { TimestampMethod, getTimestampForMessage } from "@foxglove/studio-base/util/time";

import { BlockTopicCursor } from "./BlockTopicCursor";
import {
  ChartRenderer,
  HoverElement,
  InteractionEvent,
  RenderAction,
  Scale,
} from "./ChartRenderer";
import type { Service } from "./ChartRenderer.worker";
import type {
  CsvDataset,
  DataItem,
  DatasetsBuilder,
  UpdateDataAction,
  Viewport,
} from "./DatasetsBuilder";
import { isReferenceLinePlotPathType } from "./internalTypes";
import type { PlotConfig } from "./types";

type EventTypes = {
  timeseriesBounds(bounds: Immutable<Bounds1D>): void;
};

type SeriesItem = {
  key: string;
  messagePath: string;
  parsed: RosPath;
  color: string;
  timestampMethod: TimestampMethod;
  showLine: boolean;
  lineSize: number;
  enabled: boolean;
  blockCursor: BlockTopicCursor;
};

/**
 * PlotCoordinator interfaces commands and updates between the dataset builder and the chart
 * renderer.
 */
export class PlotCoordinator extends EventEmitter<EventTypes> {
  #renderingWorker: Worker;
  #canvas: OffscreenCanvas;
  #renderer?: Promise<Comlink.RemoteObject<ChartRenderer>>;

  #datasetsBuilderWorker: Worker;
  #datasetsBuilderRemote: Comlink.Remote<Comlink.RemoteObject<DatasetsBuilder>>;

  #timeseriesBounds?: Immutable<Partial<Bounds1D>>;

  // fixme - why do we have a base range?
  #baseRange: Bounds1D = { min: 0, max: 1 };

  #seriesConfigs: Immutable<SeriesItem[]> = [];

  #followRange?: number;
  #currentTime?: Time;
  #startTime?: Time;
  #endTime?: Time;

  #lastSeekTime = 0;

  #pendingRenderActions: Immutable<RenderAction>[] = [];
  #pendingDataDispatch: Immutable<UpdateDataAction>[] = [];

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

  public constructor(canvas: OffscreenCanvas) {
    super();

    this.#canvas = canvas;
    this.#renderingWorker = new Worker(
      // foxglove-depcheck-used: babel-plugin-transform-import-meta
      new URL("./ChartRenderer.worker", import.meta.url),
    );

    this.#datasetsBuilderWorker = new Worker(
      // foxglove-depcheck-used: babel-plugin-transform-import-meta
      new URL("./datasets.worker", import.meta.url),
    );
    this.#datasetsBuilderRemote = Comlink.wrap(this.#datasetsBuilderWorker);
  }

  public indexModeHandlePlayerState(state: Immutable<PlayerState>): void {
    const activeData = state.activeData;
    if (!activeData) {
      return;
    }

    const msgEvents = activeData.messages;
    if (msgEvents.length > 0) {
      for (const seriesConfig of this.#seriesConfigs) {
        this.#pendingDataDispatch.push({
          type: "reset-current",
          series: seriesConfig.messagePath,
        });

        // loop over the events backwards and once we find our first matching topic
        // read that for the path items

        for (let i = msgEvents.length - 1; i >= 0; --i) {
          const msgEvent = msgEvents[i]!;
          if (msgEvent.topic !== seriesConfig.parsed.topicName) {
            continue;
          }

          this.#pendingDataDispatch.push({
            type: "reset-current",
            series: seriesConfig.messagePath,
          });

          const items = simpleGetMessagePathDataItems(msgEvent, seriesConfig.parsed);
          const pathItems = items.map((item, idx) => {
            const chartValue = getChartValue(item);
            return {
              x: idx,
              y: chartValue ?? NaN,
              receiveTime: msgEvent.receiveTime,
            };
          });

          this.#pendingDataDispatch.push({
            type: "append-current",
            series: seriesConfig.messagePath,
            items: pathItems,
          });

          // The base range max is the largest size of any series
          this.#baseRange = {
            min: 0,
            max: Math.max(this.#baseRange.min, items.length),
          };
          break;
        }
      }
    }

    this.#queueDispatchRender();
  }

  public handlePlayerState(state: Immutable<PlayerState>): void {
    const activeData = state.activeData;
    if (!activeData) {
      return;
    }

    const didSeek = activeData.lastSeekTime !== this.#lastSeekTime;
    this.#lastSeekTime = activeData.lastSeekTime;

    this.#startTime = activeData.startTime;
    this.#endTime = activeData.endTime;

    if (!this.#currentTime || compare(this.#currentTime, activeData.currentTime) !== 0) {
      this.#currentTime = activeData.currentTime;

      this.#pendingRenderActions.push({
        type: "current-time",
        seconds: toSec(subtractTime(this.#currentTime, this.#startTime)),
      });
    }

    // If we are using follow mode, then we will update the current time so the plot x-axis range
    // will update the display window
    if (this.#followRange != undefined) {
      this.#currentTime = activeData.currentTime;

      const max = toSec(subtractTime(this.#currentTime, this.#startTime));
      const min = max - this.#followRange;

      if (
        (this.#timeseriesBounds?.max == undefined || this.#timeseriesBounds.min == undefined) &&
        (min !== this.#baseRange.min || max !== this.#baseRange.max)
      ) {
        this.#pendingRenderActions.push({
          type: "range",
          bounds: {
            min: this.#timeseriesBounds?.min ?? min,
            max: this.#timeseriesBounds?.max ?? max,
          },
        });
      }

      this.#baseRange = {
        min,
        max,
      };
    } else {
      const max = toSec(subtractTime(this.#endTime, this.#startTime));
      const min = 0;

      if (
        (this.#timeseriesBounds?.max == undefined || this.#timeseriesBounds.min == undefined) &&
        (min !== this.#baseRange.min || max !== this.#baseRange.max)
      ) {
        this.#pendingRenderActions.push({
          type: "range",
          bounds: {
            min: this.#timeseriesBounds?.min ?? min,
            max: this.#timeseriesBounds?.max ?? max,
          },
        });
      }
      this.#baseRange = {
        min,
        max,
      };
    }

    const msgEvents = activeData.messages;
    if (msgEvents.length > 0) {
      for (const seriesConfig of this.#seriesConfigs) {
        if (didSeek) {
          this.#pendingDataDispatch.push({
            type: "reset-current",
            series: seriesConfig.messagePath,
          });
        }

        const pathItems = readMessagePathItems(
          msgEvents,
          seriesConfig.parsed,
          seriesConfig.timestampMethod,
          activeData.startTime,
        );
        this.#pendingDataDispatch.push({
          type: "append-current",
          series: seriesConfig.messagePath,
          items: pathItems,
        });
      }
    }

    const blocks = state.progress.messageCache?.blocks;
    if (blocks) {
      for (const seriesConfig of this.#seriesConfigs) {
        if (seriesConfig.blockCursor.nextWillReset(blocks)) {
          this.#pendingDataDispatch.push({
            type: "reset-full",
            series: seriesConfig.messagePath,
          });
        }

        let messageEvents = undefined;
        while ((messageEvents = seriesConfig.blockCursor.next(blocks)) != undefined) {
          const pathItems = readMessagePathItems(
            messageEvents,
            seriesConfig.parsed,
            seriesConfig.timestampMethod,
            activeData.startTime,
          );

          this.#pendingDataDispatch.push({
            type: "append-full",
            series: seriesConfig.messagePath,
            items: pathItems,
          });
        }
      }
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

    this.#followRange = config.followingViewWidth;

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

    this.#seriesConfigs = filterMap(config.paths, (path, idx) => {
      if (isReferenceLinePlotPathType(path)) {
        return;
      }

      const parsed = parseRosPath(path.value);
      if (!parsed) {
        return;
      }

      const filledParsed = fillInGlobalVariablesInPath(parsed, globalVariables);

      // When global variables change the path.value is still the original value with the variable
      // names But we need to consider this as a new series (new block cursor) so we compute new
      // values when variables cause the resolved path value to update.
      //
      // We also want to re-compute values when the timestamp method changes. So we use a _key_ that
      // is the filled path and the timestamp method. If either change, we consider this a new
      // series.
      const key = (JSON.stringify(filledParsed) as unknown as string) + path.timestampMethod;

      // It is important to keep the existing block cursor for the same series to avoid re-processing
      // the blocks again when the series remains.
      const existing = this.#seriesConfigs.find((item) => item.key === key);

      return {
        key,
        messagePath: path.value,
        parsed: filledParsed,
        color: getLineColor(path.color, idx),
        lineSize: path.lineSize ?? 1.0,
        timestampMethod: path.timestampMethod,
        showLine: path.showLine ?? true,
        enabled: path.enabled,
        blockCursor: existing?.blockCursor ?? new BlockTopicCursor(parsed.topicName),
      };
    });

    // fixme - not void?
    void this.#datasetsBuilderRemote.setConfig(this.#seriesConfigs);
  }

  public setTimeseriesBounds(bounds: Immutable<Partial<Bounds1D>>): void {
    this.#timeseriesBounds = bounds;
    this.#pendingRenderActions.push({
      type: "range",
      bounds: {
        min: bounds.min ?? this.#baseRange.min,
        max: bounds.max ?? this.#baseRange.max,
      },
    });
    this.#queueDispatchRender();
  }

  public resetBounds(): void {
    this.#timeseriesBounds = undefined;
    this.#pendingRenderActions.push({
      type: "range",
      bounds: this.#baseRange,
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

  public terminate(): void {
    this.#datasetsBuilderWorker.terminate();
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
    return await this.#datasetsBuilderRemote.getCsvData();
  }

  async #dispatchRender(): Promise<void> {
    const renderer = await this.#rendererInstance();

    // fixme - filter pending actions to only the last of each kind (except interaction events)

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
    const dispatch = this.#pendingDataDispatch;
    if (dispatch.length > 0) {
      this.#pendingDataDispatch = [];

      // fixme - filter data dispatch to remove series that are reset
      // and series that are no longer present
      // we don't need to send
      // go backwards from end to start

      await this.#datasetsBuilderRemote.updateData(dispatch);
    }

    // fixme - only do this when datasets change because we dispatch for hover events
    // also when viewport changes
    const datasets = await this.#datasetsBuilderRemote.getViewportDatasets(this.#viewport);

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

function readMessagePathItems(
  events: Immutable<MessageEvent[]>,
  path: Immutable<RosPath>,
  timestampMethod: TimestampMethod,
  startTime: Immutable<Time>,
): DataItem[] {
  const out = [];
  for (const event of events) {
    if (event.topic !== path.topicName) {
      continue;
    }

    const items = simpleGetMessagePathDataItems(event, path);
    for (const item of items) {
      const chartValue = getChartValue(item);
      if (chartValue == undefined) {
        continue;
      }

      const headerStamp = getTimestampForMessage(event.message);
      const timestamp = timestampMethod === "receiveTime" ? event.receiveTime : headerStamp;
      if (!timestamp) {
        continue;
      }

      const xValue = toSec(subtractTime(timestamp, startTime));
      out.push({
        x: xValue,
        y: chartValue,
        receiveTime: event.receiveTime,
        headerStamp,
      });
    }
  }

  return out;
}

function getChartValue(value: unknown): number | undefined {
  switch (typeof value) {
    case "bigint":
      return Number(value);
    case "boolean":
      return Number(value);
    case "number":
      return value;
    case "object":
      if (isTime(value)) {
        return toSec(value);
      }
      return undefined;
    case "string":
      return +value;
    default:
      return undefined;
  }
}
