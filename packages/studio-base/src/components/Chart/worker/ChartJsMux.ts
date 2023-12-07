// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/
//
// This file incorporates work covered by the following copyright and
// permission notice:
//
//   Copyright 2018-2021 Cruise LLC
//
//   This source code is licensed under the Apache License, Version 2.0,
//   found at http://www.apache.org/licenses/LICENSE-2.0
//   You may not use this file except in compliance with the License.

import * as Comlink from "comlink";
import {
  CategoryScale,
  Chart,
  ChartData,
  ChartOptions,
  Filler,
  Legend,
  LinearScale,
  LineController,
  LineElement,
  PointElement,
  ScatterController,
  Ticks,
  TimeScale,
  TimeSeriesScale,
  Title,
  Tooltip,
} from "chart.js";
import AnnotationPlugin from "chartjs-plugin-annotation";

import PlexMono from "@foxglove/studio-base/styles/assets/PlexMono.woff2";
import { inWebWorker } from "@foxglove/studio-base/util/workers";

import ChartJSManager, { InitOpts } from "./ChartJSManager";
import { TypedChartData } from "../types";

export type ChartUpdate = {
  data?: ChartData<"scatter">;
  typedData?: TypedChartData;
  height?: number;
  options?: ChartOptions;
  isBoundsReset?: boolean;
  width?: number;
};

// Explicitly load the "Plex Mono" font, since custom fonts from the main renderer are not inherited
// by web workers. This is required to draw "Plex Mono" on an OffscreenCanvas, and it also appears
// to fix a crash a large portion of Windows users were seeing where the rendering thread would
// crash in skia code related to DirectWrite font loading when the system display scaling is set
// >100%. For more info on this crash, see util/waitForFonts.ts.
async function loadDefaultFont(): Promise<FontFace> {
  // Passing a `url(data:...) format('woff2')` string does not work in Safari, which complains it
  // cannot load the data url due to it being cross-origin.
  // https://bugs.webkit.org/show_bug.cgi?id=265000
  const fontFace = new FontFace("IBM Plex Mono", await (await fetch(PlexMono)).arrayBuffer());
  if (typeof WorkerGlobalScope !== "undefined" && self instanceof WorkerGlobalScope) {
    (self as unknown as WorkerGlobalScope).fonts.add(fontFace);
  } else {
    document.fonts.add(fontFace);
  }
  return await fontFace.load();
}

// Immediately start font loading in the Worker thread. Each ChartJSManager we instantiate will
// wait on this promise before instantiating a new Chart instance, which kicks off rendering
const fontLoaded = loadDefaultFont();

// Register the features we support globally on our chartjs instance
// Note: Annotation plugin must be registered, it does not work _inline_ (i.e. per instance)
Chart.register(
  LineElement,
  PointElement,
  LineController,
  ScatterController,
  CategoryScale,
  LinearScale,
  TimeScale,
  TimeSeriesScale,
  Filler,
  Legend,
  Title,
  Tooltip,
  AnnotationPlugin,
);

const fixedNumberFormat = new Intl.NumberFormat(undefined, {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * Adjust the `ticks` of the chart options to ensure the first/last x labels remain a constant
 * width. See https://github.com/foxglove/studio/issues/2926
 *
 * Because this requires passing a `callback` function for the tick options, this has to be done in
 * the worker, since functions can't be sent via postMessage.
 */
function fixTicks(args: ChartUpdate): ChartUpdate {
  const xScale = args.options?.scales?.x;

  if (xScale?.ticks) {
    xScale.ticks.callback = function (value, index, ticks) {
      // use a fixed formatter for the first/last ticks
      if (index === 0 || index === ticks.length - 1) {
        return fixedNumberFormat.format(value as number);
      }
      // otherwise use chart.js's default formatter
      return Ticks.formatters.numeric.apply(this, [value as number, index, ticks]);
    };
  }
  return args;
}

let managers = new Map<string, ChartJSManager>();

const getChart = (id: string): ChartJSManager => {
  const chart = managers.get(id);
  if (!chart) {
    throw new Error(`Could not find chart with id ${id}`);
  }
  return chart;
};

export const service = {
  // create a new chartjs instance
  // this must be done before sending any other rpc requests to the instance
  initialize: (id: string, opts: InitOpts) => {
    opts.fontLoaded = fontLoaded;
    const manager = new ChartJSManager(opts);
    managers.set(id, manager);
    return manager.getScales();
  },
  wheel: (id: string, event: WheelEvent) => getChart(id).wheel(event),
  mousedown: (id: string, event: MouseEvent) => getChart(id).mousedown(event),
  mousemove: (id: string, event: MouseEvent) => getChart(id).mousemove(event),
  mouseup: (id: string, event: MouseEvent) => getChart(id).mouseup(event),
  panstart: (id: string, event: HammerInput) => getChart(id).panstart(event),
  panend: (id: string, event: HammerInput) => getChart(id).panend(event),
  panmove: (id: string, event: HammerInput) => getChart(id).panmove(event),
  update: (id: string, event: ChartUpdate) => getChart(id).update(fixTicks(event)),
  destroy: (id: string) => {
    const manager = managers.get(id);
    if (manager) {
      manager.destroy();
      managers.delete(id);
    }
  },
  getElementsAtEvent: (id: string, event: MouseEvent) => getChart(id).getElementsAtEvent(event),
  getDatalabelAtEvent: (id: string, event: Event) => getChart(id).getDatalabelAtEvent(event),
};

export const mainThread = {
  initialize: async (id: string, opts: InitOpts) => service.initialize(id, opts),
  wheel: async (id: string, event: WheelEvent) => service.wheel(id, event),
  mousedown: async (id: string, event: MouseEvent) => service.mousedown(id, event),
  mousemove: async (id: string, event: MouseEvent) => service.mousemove(id, event),
  mouseup: async (id: string, event: MouseEvent) => service.mouseup(id, event),
  panstart: async (id: string, event: HammerInput) => service.panstart(id, event),
  panend: async (id: string, event: HammerInput) => service.panend(id, event),
  panmove: async (id: string, event: HammerInput) => service.panmove(id, event),
  update: async (id: string, event: ChartUpdate) => service.update(id, event),
  destroy: async (id: string) => service.destroy(id),
  getElementsAtEvent: async (id: string, event: MouseEvent) =>
    service.getElementsAtEvent(id, event),
  getDatalabelAtEvent: async (id: string, event: Event) => service.getDatalabelAtEvent(id, event),
};

if (inWebWorker()) {
  Comlink.expose(service);
}
