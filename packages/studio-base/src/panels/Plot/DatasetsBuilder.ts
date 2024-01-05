// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { toSec } from "@foxglove/rostime";
import { Immutable, Time } from "@foxglove/studio";
import { downsampleTimeseries } from "@foxglove/studio-base/components/TimeBasedChart/downsample";
import { Bounds1D } from "@foxglove/studio-base/components/TimeBasedChart/types";
import { TimestampMethod } from "@foxglove/studio-base/util/time";

import { Dataset, DatumMetadata } from "./ChartRenderer";

export type DataItem = DatumMetadata & {
  sinceStart: Time;
  receiveTime: Time;
  headerStamp?: Time;
};

type Size = { width: number; height: number };

export type Viewport = {
  // The numeric bounds of the viewport. When x or y are undefined, that axis is not bounded
  // and assumed to display the entire range from the data.
  bounds: {
    x?: Bounds1D;
    y?: Bounds1D;
  };
  size: Size;
};

type SeriesConfig = {
  key: string;
  messagePath: string;
  color: string;
  timestampMethod: TimestampMethod;
  showLine: boolean;
  lineSize: number;
  enabled: boolean;
};

type FullDatum = DataItem & {
  index: number;
  x: number;
  y: number;
  label: string | undefined;
};

type Series = {
  config: SeriesConfig;
  current: FullDatum[];
  full: FullDatum[];
};

type ResetSeriesFullAction = {
  type: "reset-full";
  series: string;
};

type ResetSeriesCurrentAction = {
  type: "reset-current";
  series: string;
};

type UpdateSeriesCurrentAction = {
  type: "append-current";
  series: string;
  items: DataItem[];
};

type UpdateSeriesFullAction = {
  type: "append-full";
  series: string;
  items: DataItem[];
};

export type UpdateDataAction =
  | ResetSeriesFullAction
  | ResetSeriesCurrentAction
  | UpdateSeriesCurrentAction
  | UpdateSeriesFullAction;

export class DatasetsBuilder {
  #seriesByMessagePath = new Map<string, Series>();

  public updateData(actions: Immutable<UpdateDataAction[]>): void {
    for (const action of actions) {
      this.#applyAction(action);
    }
  }

  public setConfig(seriesConfig: Immutable<SeriesConfig[]>): void {
    // Make a new map so we drop series which are no longer present
    const newSeries = new Map();

    for (const config of seriesConfig) {
      let existingSeries = this.#seriesByMessagePath.get(config.messagePath);
      // fixme - key good for this? rename key to hash or identifier
      if (!existingSeries || existingSeries.config.key !== config.key) {
        existingSeries = {
          config,
          current: [],
          full: [],
        };
      }
      newSeries.set(config.messagePath, existingSeries);
      existingSeries.config = config;
    }
    this.#seriesByMessagePath = newSeries;
  }

  public getViewportDatasets(viewport: Immutable<Viewport>): Dataset[] {
    // timestamp plots - the x value is calculated as offset from the start time

    // index plots - the x value is the index of the datum in the full dataset
    // msg path (current) - x values are the items in the current message only
    // msg path (accumulated) - x values are items from all the messages

    const datasets: Dataset[] = [];
    for (const series of this.#seriesByMessagePath.values()) {
      if (!series.config.enabled) {
        continue;
      }

      // fixme
      const dataset: Dataset = {
        borderColor: series.config.color,
        showLine: true,
        fill: false,
        borderWidth: series.config.lineSize,
        pointRadius: series.config.lineSize,
        pointHoverRadius: 3,
        pointBackgroundColor: series.config.color,
        // fixme
        //pointBackgroundColor: invertedTheme ? lightColor(borderColor) : darkColor(borderColor),
        pointBorderColor: "transparent",
        data: [],
      };

      const allData = series.full.slice();

      // add only the current data that is not already present in full
      const lastX = allData[allData.length]?.x;
      if (lastX != undefined) {
        let idx = 0;
        for (const item of series.current) {
          if (item.x > lastX) {
            break;
          }
          idx += 1;
        }

        // fixme - can do this before ever sending current data
        if (idx > 0) {
          series.current.splice(0, idx - 1);
          if (series.current.length > 0) {
            allData.push(...series.current);
          }
        }
      } else {
        allData.push(...series.current);
      }

      let startIdx = 0;
      let endIdx = allData.length;

      const xBounds: Bounds1D = { min: 0, max: 0 };
      const yBounds: Bounds1D = { min: 0, max: 0 };

      for (let i = 0; i < allData.length; ++i) {
        const item = allData[i]!;
        item.index = i;

        if (viewport.bounds.x && item.x < viewport.bounds.x.min) {
          startIdx = i;
          continue;
        }

        xBounds.min = Math.min(xBounds.min, item.x);
        xBounds.max = Math.max(xBounds.max, item.x);

        yBounds.min = Math.min(yBounds.min, item.y);
        yBounds.max = Math.max(yBounds.max, item.y);

        if (viewport.bounds.x && item.x > viewport.bounds.x.max) {
          endIdx = i;
          break;
        }
      }

      const items = allData.slice(startIdx, endIdx + 1);

      // fixme - max points argument
      const downsampledIndicies = downsampleTimeseries(items, {
        width: viewport.size.width,
        height: viewport.size.height,
        bounds: {
          x: viewport.bounds.x ?? xBounds,
          y: viewport.bounds.y ?? yBounds,
        },
      });

      // When a series is downsampled the points are disabled as a visual indicator that
      // data is downsampled.
      if (downsampledIndicies.length < items.length) {
        dataset.pointRadius = 0;
      }

      for (const index of downsampledIndicies) {
        const item = allData[index];
        if (!item) {
          continue;
        }

        dataset.data.push(item);
      }

      datasets.push(dataset);
    }

    return datasets;
  }

  #applyAction(action: Immutable<UpdateDataAction>): void {
    switch (action.type) {
      case "reset-current": {
        const series = this.#seriesByMessagePath.get(action.series);
        if (!series) {
          return;
        }
        // when we reset current we make a new array since we'll assume the full will load
        // we won't need to keep getting current data
        series.current = [];
        break;
      }
      case "reset-full": {
        const series = this.#seriesByMessagePath.get(action.series);
        if (!series) {
          return;
        }
        // splice to keep underlying memory since we typically expect to fill it again
        series.full.splice(0, series.full.length);
        break;
      }
      case "append-current": {
        const series = this.#seriesByMessagePath.get(action.series);
        if (!series) {
          return;
        }

        for (const item of action.items) {
          // fixme - how can value be undefined?
          if (item.value == undefined) {
            return;
          }

          const idx = series.current.length;
          series.current.push({
            index: idx,
            x: toSec(item.sinceStart),
            y: Number(item.value),
            label: undefined,
            ...item,
          });
        }
        break;
      }
      case "append-full": {
        const series = this.#seriesByMessagePath.get(action.series);
        if (!series) {
          return;
        }

        for (const item of action.items) {
          // fixme - how can value be undefined?
          if (item.value == undefined) {
            return;
          }

          const idx = series.full.length;
          series.full.push({
            index: idx,
            x: toSec(item.sinceStart),
            y: Number(item.value),
            label: undefined,
            ...item,
          });
        }
        break;
      }
    }
  }
}
