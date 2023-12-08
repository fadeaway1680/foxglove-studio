// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

// These modules declaration merge into chart.js declarations for plugins
// Since we don't use the modules directly in this file, we need to load the types as references
// so typescript will have the merged declarations.
/// <reference types="chartjs-plugin-datalabels" />
/// <reference types="@foxglove/chartjs-plugin-zoom" />

import * as Comlink from "comlink";
import { ChartOptions, ChartItem } from "chart.js";
import Hammer from "hammerjs";
import * as R from "ramda";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { useMountedState } from "react-use";
import { assert } from "ts-essentials";
import { v4 as uuidv4 } from "uuid";

import { type ZoomPluginOptions } from "@foxglove/chartjs-plugin-zoom/types/options";
import Logger from "@foxglove/log";
import {
  ChartUpdate,
  mainThread as ChartJsMux,
} from "@foxglove/studio-base/components/Chart/worker/ChartJsMux";
import { InitOpts } from "@foxglove/studio-base/components/Chart/worker/ChartJSManager";
import { mightActuallyBePartial } from "@foxglove/studio-base/util/mightActuallyBePartial";
import { multiplex, scheme1to1 } from "@foxglove/den/workers";

import { TypedChartData, ChartData, RpcElement, RpcScales } from "./types";

type PartialUpdate = Partial<ChartUpdate>;

const log = Logger.getLogger(__filename);

export type OnClickArg = {
  datalabel?: unknown;
  // x-value in scale
  x: number | undefined;
  // y-value in scale
  y: number | undefined;
};

type Props = {
  data?: ChartData;
  typedData?: TypedChartData;
  options: ChartOptions;
  isBoundsReset: boolean;
  type: "scatter";
  height: number;
  width: number;
  onClick?: (params: OnClickArg) => void;

  // called when the chart scales have updated (happens for zoom/pan/reset)
  onScalesUpdate?: (scales: RpcScales, opt: { userInteraction: boolean }) => void;

  // called when the chart is about to start rendering new data
  onStartRender?: () => void;

  // called when the chart has finished updating with new data
  onFinishRender?: () => void;

  // called when a user hovers over an element
  // uses the chart.options.hover configuration
  onHover?: (elements: RpcElement[]) => void;
};

const devicePixelRatio = mightActuallyBePartial(window).devicePixelRatio ?? 1;

type ChartService = Comlink.Remote<(typeof import("./worker/ChartJsMux"))["service"]>;

const createWorker = multiplex(
  (): [ChartService, Worker] => {
    const worker = new Worker(
      // foxglove-depcheck-used: babel-plugin-transform-import-meta
      new URL("./worker/ChartJsMux", import.meta.url),
    );
    return [Comlink.wrap(worker), worker];
  },
  ([, worker]) => {
    worker.terminate();
  },
  scheme1to1,
);

// turn a React.MouseEvent into an object we can send over rpc
function rpcMouseEvent(event: React.MouseEvent<HTMLElement>) {
  const boundingRect = event.currentTarget.getBoundingClientRect();

  return {
    cancelable: false,
    clientX: event.clientX - boundingRect.left,
    clientY: event.clientY - boundingRect.top,
    target: {
      boundingClientRect: boundingRect.toJSON(),
    },
  };
}

// Chart component renders data using workers with chartjs offscreen canvas

const supportsOffscreenCanvas =
  typeof HTMLCanvasElement.prototype.transferControlToOffscreen === "function";

function Chart(props: Props): JSX.Element {
  const [id] = useState(() => uuidv4());

  const initialized = useRef(false);
  const canvasRef = useRef<HTMLCanvasElement>();
  const containerRef = useRef<HTMLDivElement>(ReactNull);
  const isMounted = useMountedState();

  // to avoid changing useCallback deps for callbacks which access the scale value
  // at the time they are invoked
  const currentScalesRef = useRef<RpcScales | undefined>();

  const zoomEnabled =
    (props.options.plugins?.zoom as ZoomPluginOptions | undefined)?.zoom?.enabled ?? false;
  const panEnabled =
    (props.options.plugins?.zoom as ZoomPluginOptions | undefined)?.pan?.enabled ?? false;

  const {
    type,
    data,
    typedData,
    isBoundsReset,
    options,
    width,
    height,
    onStartRender,
    onFinishRender,
  } = props;

  const serviceRef = useRef<ChartService | undefined>();

  const hasPannedSinceMouseDown = useRef(false);
  const queuedUpdates = useRef<PartialUpdate[]>([]);
  const isSending = useRef<boolean>(false);
  const previousUpdateMessage = useRef<Record<string, unknown>>({});

  useLayoutEffect(() => {
    log.info(`Register Chart ${id}`);
    let service: ChartService;
    let dispose: () => void = () => {};

    if (supportsOffscreenCanvas) {
      const [[instance], disposeWorker] = createWorker();
      service = instance;
      dispose = disposeWorker;
    } else {
      service = ChartJsMux as ChartService;
    }

    serviceRef.current = service;

    return () => {
      dispose();
      log.info(`Unregister chart ${id}`);
      service.destroy(id).catch(() => {}); // may fail if worker is torn down
      serviceRef.current = undefined;
      initialized.current = false;
      previousUpdateMessage.current = {};
      canvasRef.current?.remove();
      canvasRef.current = undefined;
    };
  }, [id]);

  // trigger when scales update
  const onScalesUpdateRef = useRef(props.onScalesUpdate);
  onScalesUpdateRef.current = props.onScalesUpdate;

  const maybeUpdateScales = useCallback(
    (newScales: RpcScales, opt?: { userInteraction: boolean }) => {
      if (!isMounted()) {
        return;
      }

      const oldScales = currentScalesRef.current;
      currentScalesRef.current = newScales;

      // cheap hack to only update the scales when the values change
      // avoids triggering handlers that depend on scales
      const oldStr = JSON.stringify(oldScales);
      const newStr = JSON.stringify(newScales);
      if (oldStr !== newStr) {
        onScalesUpdateRef.current?.(newScales, opt ?? { userInteraction: false });
      }
    },
    [isMounted],
  );

  // getNewUpdateMessage returns an update message for the changed fields from the last
  // call to get an update message
  //
  // The purpose of this mechanism is to avoid sending data/options/size to the worker
  // if they are unchanged from a previous initialization or update.
  const getNewUpdateMessage = useCallback(() => {
    const prev = previousUpdateMessage.current;
    const out: PartialUpdate = {};

    // NOTE(Roman): I don't know why this happens but when I initialize a chart using some data
    // and width/height of 0. Even when I later send an update for correct width/height the chart
    // does not render.
    //
    // The workaround here is to avoid sending any initialization or update messages until we have
    // a width and height that are non-zero
    if (width === 0 || height === 0) {
      return undefined;
    }

    if (prev.data !== data) {
      prev.data = out.data = data;
    }
    if (prev.typedData !== typedData) {
      prev.typedData = out.typedData = typedData;
    }
    if (prev.options !== options) {
      prev.options = out.options = options;
    }
    if (prev.height !== height) {
      prev.height = out.height = height;
    }
    if (prev.width !== width) {
      prev.width = out.width = width;
    }

    out.isBoundsReset = isBoundsReset;

    // nothing to update
    if (Object.keys(out).length === 0) {
      return;
    }

    return out;
  }, [data, typedData, height, options, isBoundsReset, width]);

  // Flush all new updates to the worker, coalescing them together if there is
  // more than one.
  const flushUpdates = useCallback(
    async (service: ChartService | undefined) => {
      if (service == undefined || isSending.current) {
        return;
      }

      isSending.current = true;

      while (queuedUpdates.current.length > 0) {
        const { current: updates } = queuedUpdates;
        if (updates.length === 0) {
          break;
        }

        // We merge all of the pending updates together to do as few renders as
        // possible when we fall behind
        const coalesced = R.mergeAll(updates);
        onStartRender?.();
        const scales = await service.update(id, coalesced);
        maybeUpdateScales(scales);
        onFinishRender?.();
        queuedUpdates.current = queuedUpdates.current.slice(updates.length);
      }

      isSending.current = false;
    },
    [maybeUpdateScales, onFinishRender, onStartRender],
  );

  // Update the chart with a new set of data
  const updateChart = useCallback(
    async (update: PartialUpdate) => {
      if (initialized.current) {
        queuedUpdates.current = [...queuedUpdates.current, update];
        await flushUpdates(serviceRef.current);
        return;
      }

      // first time initialization
      assert(canvasRef.current == undefined, "Canvas has already been initialized");
      assert(containerRef.current, "No container ref");
      assert(serviceRef.current, "No RPC");

      const canvas = document.createElement("canvas");
      canvas.style.width = "100%";
      canvas.style.height = "100%";
      canvas.width = update.width ?? 0;
      canvas.height = update.height ?? 0;
      containerRef.current.appendChild(canvas);

      canvasRef.current = canvas;
      initialized.current = true;

      onStartRender?.();

      const offscreenCanvas: OffscreenCanvas | undefined =
        typeof canvas.transferControlToOffscreen === "function"
          ? canvas.transferControlToOffscreen()
          : undefined;

      // There are some inconsistencies for the HTMLCanvasElement and
      // OffscreenCanvas types in that they are substitutable (since they both
      // have `getContext`), but this commonality is not reflected. As a
      // result, an OffscreenCanvas cannot be used in place of
      // HTMLCanvasElement despite the fact that this works without problems,
      // at least in ChartJS's usage of HTMLCanvasElement.
      const node: ChartItem =
        offscreenCanvas != undefined
          ? (offscreenCanvas as unknown as HTMLCanvasElement)
          : { canvas };

      const initOpts: InitOpts = {
        type,
        node,
        options: update.options,
        devicePixelRatio,
      };

      // We need to explicitly transfer the offscreenCanvas here if we're using it
      const transferOpts: InitOpts =
        offscreenCanvas != undefined ? Comlink.transfer(initOpts, [offscreenCanvas]) : initOpts;

      const scales = await serviceRef.current.initialize(id, transferOpts);
      maybeUpdateScales(scales);
      onFinishRender?.();

      // We cannot rely solely on the call to `initialize`, since it doesn't
      // actually produce the first frame. However, if we append this update to
      // the end, it will overwrite updates that have been queued _since we
      // started initializing_. This is incorrect behavior and can set the
      // scales incorrectly on weak devices.
      //
      // To prevent this from happening, we put this update at the beginning of
      // the queue so that it gets coalesced properly.
      queuedUpdates.current = [update, ...queuedUpdates.current];
      await flushUpdates(serviceRef.current);
    },
    [maybeUpdateScales, onFinishRender, onStartRender, type, flushUpdates],
  );

  const [updateError, setUpdateError] = useState<Error | undefined>();
  useLayoutEffect(() => {
    if (!containerRef.current) {
      return;
    }

    setUpdateError(undefined);

    const newUpdate = getNewUpdateMessage();
    if (!newUpdate) {
      return;
    }

    updateChart(newUpdate).catch((err: Error) => {
      if (isMounted()) {
        setUpdateError(err);
      }
    });
  }, [getNewUpdateMessage, isMounted, updateChart]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || !panEnabled) {
      return;
    }

    const hammerManager = new Hammer.Manager(container);
    const threshold = props.options.plugins?.zoom?.pan?.threshold ?? 10;
    hammerManager.add(new Hammer.Pan({ threshold }));

    hammerManager.on("panstart", async (event) => {
      hasPannedSinceMouseDown.current = true;

      if (!serviceRef.current) {
        return;
      }

      await serviceRef.current.panstart(
        id,
        {
          deltaY: event.deltaY,
          deltaX: event.deltaX,
          center: {
            x: event.center.x,
            y: event.center.y,
          },
          target: {} as HTMLElement,
        },
        event.target.getBoundingClientRect(),
      );
    });

    hammerManager.on("panmove", async (event) => {
      if (!serviceRef.current) {
        return;
      }

      const scales = await serviceRef.current.panmove(
        id,
        {
          deltaY: event.deltaY,
          deltaX: event.deltaX,
          target: {} as HTMLElement,
        },
        event.target.getBoundingClientRect(),
      );
      maybeUpdateScales(scales, { userInteraction: true });
    });

    hammerManager.on("panend", async (event) => {
      if (!serviceRef.current) {
        return;
      }

      const scales = await serviceRef.current.panend(id, {
        deltaY: event.deltaY,
        deltaX: event.deltaX,
        boundingClientRect: event.target.getBoundingClientRect(),
      });
      maybeUpdateScales(scales, { userInteraction: true });
    });

    return () => {
      hammerManager.destroy();
    };
  }, [maybeUpdateScales, panEnabled, props.options.plugins?.zoom?.pan?.threshold]);

  const onWheel = useCallback(
    async (event: React.WheelEvent<HTMLElement>) => {
      if (!zoomEnabled || !serviceRef.current) {
        return;
      }

      const scales = await serviceRef.current.wheel(
        id,
        {
          cancelable: false,
          deltaY: event.deltaY,
          deltaX: event.deltaX,
          clientX: event.clientX,
          clientY: event.clientY,
          target: {} as HTMLElement,
        },
        event.currentTarget.getBoundingClientRect(),
      );
      maybeUpdateScales(scales, { userInteraction: true });
    },
    [zoomEnabled, maybeUpdateScales],
  );

  const onMouseDown = useCallback(
    async (event: React.MouseEvent<HTMLElement>) => {
      hasPannedSinceMouseDown.current = false;

      if (!serviceRef.current) {
        return;
      }

      const scales = await serviceRef.current.mousedown(
        id,
        rpcMouseEvent(event),
        event.currentTarget.getBoundingClientRect(),
      );

      maybeUpdateScales(scales);
    },
    [maybeUpdateScales],
  );

  const onMouseUp = useCallback(async (event: React.MouseEvent<HTMLElement>) => {
    if (!serviceRef.current) {
      return;
    }

    return await serviceRef.current.mouseup(
      id,
      rpcMouseEvent(event),
      event.currentTarget.getBoundingClientRect(),
    );
  }, []);

  // Since hover events are handled via rpc, we might get a response back when we've
  // already hovered away from the chart. We gate calling onHover by whether the mouse is still
  // present on the component
  const mousePresentRef = useRef(false);

  const { onHover } = props;
  const onMouseMove = useCallback(
    async (event: React.MouseEvent<HTMLElement>) => {
      mousePresentRef.current = true; // The mouse must be present if we're getting this event.

      if (onHover == undefined || serviceRef.current == undefined) {
        return;
      }

      const elements = await serviceRef.current.getElementsAtEvent(id, rpcMouseEvent(event));

      // Check mouse presence again in case the mouse has left the canvas while we
      // were waiting for the RPC call.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (isMounted() && mousePresentRef.current) {
        onHover(elements);
      }
    },
    [onHover, isMounted],
  );

  const onMouseEnter = useCallback(() => {
    mousePresentRef.current = true;
  }, []);

  const onMouseLeave = useCallback(() => {
    mousePresentRef.current = false;
    onHover?.([]);
  }, [onHover]);

  const onClick = useCallback(
    async (event: React.MouseEvent<HTMLElement>): Promise<void> => {
      if (
        !props.onClick ||
        !serviceRef.current ||
        !isMounted() ||
        hasPannedSinceMouseDown.current // Don't send click event if it was part of a pan gesture.
      ) {
        return;
      }

      const rect = event.currentTarget.getBoundingClientRect();
      const mouseX = event.clientX - rect.left;
      const mouseY = event.clientY - rect.top;

      // maybe we should forward the click event and add support for datalabel listeners
      // the rpc channel doesn't have a way to send rpc back...
      const datalabel = await serviceRef.current.getDatalabelAtEvent(id, {
        x: mouseX,
        y: mouseY,
        type: "click",
      });

      let xVal: number | undefined;
      let yVal: number | undefined;

      const xScale = currentScalesRef.current?.x;
      if (xScale) {
        const pixels = xScale.pixelMax - xScale.pixelMin;
        const range = xScale.max - xScale.min;
        xVal = (range / pixels) * (mouseX - xScale.pixelMin) + xScale.min;
      }

      const yScale = currentScalesRef.current?.y;
      if (yScale) {
        const pixels = yScale.pixelMax - yScale.pixelMin;
        const range = yScale.max - yScale.min;
        yVal = (range / pixels) * (mouseY - yScale.pixelMin) + yScale.min;
      }

      props.onClick({
        datalabel,
        x: xVal,
        y: yVal,
      });
    },
    [isMounted, props],
  );

  if (updateError) {
    throw updateError;
  }

  return (
    <div
      ref={containerRef}
      onWheel={onWheel}
      onClick={onClick}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseLeave={onMouseLeave}
      onMouseEnter={onMouseEnter}
      onMouseUp={onMouseUp}
      style={{ width, height, cursor: "crosshair", position: "relative" }}
    />
  );
}

export default Chart;
