// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { Chart, ChartDataset, ChartOptions, ScatterDataPoint } from "chart.js";
import { AnnotationOptions } from "chartjs-plugin-annotation";
import EventEmitter from "eventemitter3";

import { Zoom as ZoomPlugin } from "@foxglove/chartjs-plugin-zoom";
import { Immutable } from "@foxglove/studio";
import { Bounds1D } from "@foxglove/studio-base/components/TimeBasedChart/types";
import { maybeCast } from "@foxglove/studio-base/util/maybeCast";
import { fontMonospace } from "@foxglove/theme";

export type Scale = {
  min: number;
  max: number;
  left: number;
  right: number;
};

type BaseInteractionEvent = {
  cancelable: boolean;
  deltaY: number;
  deltaX: number;

  boundingClientRect: DOMRect;
};

type MouseBase = BaseInteractionEvent & {
  clientX: number;
  clientY: number;
};

type WheelInteractionEvent = { type: "wheel" } & BaseInteractionEvent & MouseBase;
type PanStartInteractionEvent = { type: "panstart" } & BaseInteractionEvent & {
    center: { x: number; y: number };
  };
type PanMoveInteractionEvent = { type: "panmove" } & BaseInteractionEvent;
type PanEndInteractionEvent = { type: "panend" } & BaseInteractionEvent;

export type InteractionEvent =
  | WheelInteractionEvent
  | PanStartInteractionEvent
  | PanMoveInteractionEvent
  | PanEndInteractionEvent;

export type Datum = ScatterDataPoint;
export type Dataset = ChartDataset<"scatter", Datum[]>;

type ChartType = Chart<"scatter", Datum[]>;

type Bounds = {
  x: Bounds1D;
  y: Bounds1D;
};

export type HoverElement = {
  data: Datum;
  datasetIndex: number;
};

type UpdateSizeAction = {
  type: "size";
  size: { width: number; height: number };
};

type UpdateRangeAction = {
  type: "range";
  bounds: Bounds1D;
};

type InteractionEventAction = {
  type: "event";
  event: InteractionEvent;
};

type UpdateHoverAction = {
  type: "hover";
  seconds?: number;
};

type UpdateCurrentTimeAction = {
  type: "current-time";
  seconds?: number;
};

type ReferenceLinesAction = {
  type: "references-lines";
  referenceLines: { color: string; value: number }[];
};

export type RenderAction =
  | UpdateSizeAction
  | UpdateRangeAction
  | InteractionEventAction
  | ReferenceLinesAction
  | UpdateHoverAction
  | UpdateCurrentTimeAction;

function addEventListener(emitter: EventEmitter) {
  return (eventName: string, fn?: () => void) => {
    const existing = emitter.listeners(eventName);
    if (!fn || existing.includes(fn)) {
      return;
    }

    emitter.on(eventName, fn);
  };
}

function removeEventListener(emitter: EventEmitter) {
  return (eventName: string, fn?: () => void) => {
    if (fn) {
      emitter.off(eventName, fn);
    }
  };
}

// allows us to override the chart.ctx instance field which zoom plugin uses for adding event listeners
type MutableContext<T> = Omit<Chart, "ctx"> & { ctx: T };

type PanEvent = {
  deltaX: number;
  deltaY: number;
};

type PanStartEvent = PanEvent & {
  center: { x: number; y: number };
  target: {
    getBoundingClientRect(): DOMRect;
  };
};

type ZoomableChart = Chart & {
  $zoom: {
    panStartHandler(event: PanStartEvent): void;
    panHandler(event: PanEvent): void;
    panEndHandler(): void;
  };
};

export class ChartRenderer {
  #chartInstance: ChartType;
  #fakeNodeEvents = new EventEmitter();
  #fakeDocumentEvents = new EventEmitter();

  #hoverValue?: number;
  #currentValue?: number;

  public constructor(args: { canvas: OffscreenCanvas; devicePixelRatio: number }) {
    const fakeNode = {
      addEventListener: addEventListener(this.#fakeNodeEvents),
      removeEventListener: removeEventListener(this.#fakeNodeEvents),
      ownerDocument: {
        addEventListener: addEventListener(this.#fakeDocumentEvents),
        removeEventListener: removeEventListener(this.#fakeDocumentEvents),
      },
    };

    const origZoomStart = ZoomPlugin.start?.bind(ZoomPlugin);
    ZoomPlugin.start = (chartInstance: MutableContext<unknown>, startArgs, pluginOptions) => {
      // swap the canvas with our fake dom node canvas to support zoom plugin addEventListener
      const ctx = chartInstance.ctx;
      chartInstance.ctx = {
        canvas: fakeNode,
      };
      const res = origZoomStart?.(chartInstance as Chart, startArgs, pluginOptions);
      chartInstance.ctx = ctx;
      return res;
    };

    const fullOptions: ChartOptions<"scatter"> = {
      maintainAspectRatio: false,
      animation: false,
      // Disable splines, they seem to cause weird rendering artifacts:
      elements: { line: { tension: 0 } },
      interaction: {
        intersect: false,
        mode: "x",
      },
      devicePixelRatio: args.devicePixelRatio,
      font: { family: fontMonospace, size: 10 },
      // we force responsive off since we manually trigger width/height updates on the chart
      // responsive mode does not work properly with offscreen canvases and retina device pixel ratios
      // it results in a run-away canvas that keeps doubling in size!
      responsive: false,
      // https://www.chartjs.org/docs/latest/general/data-structures.html#dataset-configuration
      parsing: false,
      scales: {
        x: {
          display: true,
        },
        y: {
          display: true,
        },
      },
      plugins: {
        decimation: {
          enabled: false,
        },
        tooltip: {
          enabled: false, // Disable native tooltips since we use custom ones.
        },
        zoom: {
          zoom: {
            enabled: true,
            mode: "x",
            sensitivity: 3,
            speed: 0.1,
          },
          pan: {
            mode: "xy",
            enabled: true,
            speed: 20,
            threshold: 10,
          },
        },
        annotation: {
          annotations: [
            {
              type: "line",
              drawTime: "beforeDatasetsDraw",
              xMin: () => this.#hoverValue ?? Number.MIN_SAFE_INTEGER,
              xMax: () => this.#hoverValue ?? Number.MIN_SAFE_INTEGER,
              borderColor: "rgb(0 , 99, 132)",
              borderWidth: 1,
            },
            {
              type: "line",
              drawTime: "beforeDatasetsDraw",
              xMin: () => this.#currentValue ?? Number.MIN_SAFE_INTEGER,
              xMax: () => this.#currentValue ?? Number.MIN_SAFE_INTEGER,
              borderColor: "rgb(255 , 99, 132)",
              borderWidth: 1,
            },
          ],
        },
      },
    };

    // ChartJS supports offscreen canvas however the type definitions do not so we need to cast and
    // fool the constructor.
    //
    // https://www.chartjs.org/docs/latest/general/performance.html#parallel-rendering-with-web-workers-chromium-only
    const canvas = args.canvas as unknown as HTMLCanvasElement;
    const chartInstance = new Chart<"scatter", Datum[]>(canvas, {
      type: "scatter",
      data: {
        datasets: [],
      },
      options: fullOptions,
      plugins: [ZoomPlugin],
    });

    ZoomPlugin.start = origZoomStart;
    this.#chartInstance = chartInstance;
  }

  public dispatchActions(actions: Immutable<RenderAction[]>): Bounds | undefined {
    for (const action of actions) {
      this.#applyAction(action);
    }

    // NOTE: "none" disables animations - this is important for chart performance because we update
    // the entire data set which does not preserve history for the chart animations
    this.#chartInstance.update("none");

    // fill our rpc scales - we only support x and y scales for now
    const xScale = this.#chartInstance.scales.x;
    const yScale = this.#chartInstance.scales.y;

    if (!xScale || !yScale) {
      return undefined;
    }

    return {
      x: {
        min: xScale.min,
        max: xScale.max,
      },
      y: {
        min: yScale.min,
        max: yScale.max,
      },
    };
  }

  public getElementsAtPixel(pixel: { x: number; y: number }): HoverElement[] {
    const x = pixel.x;
    const y = pixel.y;

    const ev = {
      native: true,
      x,
      y,
    };

    // ev is cast to any because the typings for getElementsAtEventForMode are wrong
    // ev is specified as a dom Event - but the implementation does not require it for the basic platform
    const elements = this.#chartInstance.getElementsAtEventForMode(
      ev as unknown as Event,
      this.#chartInstance.options.interaction?.mode ?? "intersect",
      this.#chartInstance.options.interaction ?? {},
      false,
    );

    const out: HoverElement[] = [];

    for (const element of elements) {
      const data = this.#chartInstance.data.datasets[element.datasetIndex]?.data[element.index];
      if (data == undefined || typeof data === "number") {
        continue;
      }

      out.push({
        data,
        datasetIndex: element.datasetIndex,
      });
    }

    return out;
  }

  public updateDatasets(datasets: Dataset[]): Scale | undefined {
    this.#chartInstance.data.datasets = datasets;

    // While the chartjs API doesn't indicate update should be called after resize, in practice
    // we've found that performing a resize after an update sometimes results in a blank chart.
    //
    // NOTE: "none" disables animations - this is important for chart performance because we update
    // the entire data set which does not preserve history for the chart animations
    this.#chartInstance.update("none");
    return this.#getXScale();
  }

  #getXScale(): Scale | undefined {
    const xScale = this.#chartInstance.scales.x;
    if (!xScale) {
      return undefined;
    }

    return {
      min: xScale.min,
      max: xScale.max,
      left: xScale.left,
      right: xScale.right,
    };
  }

  #applyAction(action: Immutable<RenderAction>): void {
    switch (action.type) {
      case "size":
        this.#chartInstance.canvas.width = action.size.width;
        this.#chartInstance.canvas.height = action.size.height;
        this.#chartInstance.resize();
        break;
      case "hover":
        this.#hoverValue = action.seconds;
        break;
      case "current-time":
        this.#currentValue = action.seconds;
        break;
      case "event":
        this.#applyInteractionEvent(action.event);

        break;
      case "range": {
        const instanceScalesX = this.#chartInstance.options.scales?.x;
        if (instanceScalesX) {
          instanceScalesX.min = action.bounds.min;
          instanceScalesX.max = action.bounds.max;
        }
        break;
      }
      case "references-lines": {
        const annotation = this.#chartInstance.options.plugins?.annotation;
        if (!annotation) {
          return;
        }

        const newAnnotations: AnnotationOptions[] = action.referenceLines.map((config) => {
          return {
            type: "line",
            display: true,
            drawTime: "beforeDatasetsDraw",
            scaleID: "y",
            borderColor: config.color,
            borderDash: [5, 5],
            borderWidth: 1,
            value: config.value,
          };
        });

        newAnnotations.push({
          type: "line",
          drawTime: "beforeDatasetsDraw",
          display: () => this.#hoverValue != undefined,
          xMin: () => this.#hoverValue ?? Number.MIN_SAFE_INTEGER,
          xMax: () => this.#hoverValue ?? Number.MIN_SAFE_INTEGER,
          borderColor: "rgb(0 , 99, 132)",
          borderWidth: 1,
        });

        newAnnotations.push({
          type: "line",
          drawTime: "beforeDatasetsDraw",
          display: () => this.#hoverValue != undefined,
          xMin: () => this.#currentValue ?? Number.MIN_SAFE_INTEGER,
          xMax: () => this.#currentValue ?? Number.MIN_SAFE_INTEGER,
          borderColor: "rgb(255 , 99, 132)",
          borderWidth: 1,
        });

        annotation.annotations = newAnnotations;
        break;
      }
    }
  }

  #applyInteractionEvent(event: Immutable<InteractionEvent>): void {
    const { type, boundingClientRect, ...rest } = event;
    switch (type) {
      case "wheel":
        this.#fakeNodeEvents.emit("wheel", {
          ...rest,
          target: {
            getBoundingClientRect() {
              return boundingClientRect;
            },
          },
        });
        break;
      case "panstart":
        maybeCast<ZoomableChart>(this.#chartInstance)?.$zoom.panStartHandler({
          center: event.center,
          deltaX: event.deltaX,
          deltaY: event.deltaY,
          target: {
            getBoundingClientRect() {
              return boundingClientRect;
            },
          },
        });
        break;
      case "panmove":
        maybeCast<ZoomableChart>(this.#chartInstance)?.$zoom.panHandler(event);
        break;
      case "panend":
        maybeCast<ZoomableChart>(this.#chartInstance)?.$zoom.panEndHandler();
        break;
    }
  }
}
