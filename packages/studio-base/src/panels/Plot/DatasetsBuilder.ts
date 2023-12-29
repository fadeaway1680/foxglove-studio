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
  bounds: {
    x: Bounds1D;
    y: Bounds1D;
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

type ResetSeriesAction = {
  type: "reset";
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

type UpdateSeriesAction = UpdateSeriesCurrentAction | UpdateSeriesFullAction;
export type UpdateDataAction = ResetSeriesAction | UpdateSeriesAction;

export class DatasetsBuilder {
  #seriesByMessagePath = new Map<string, Series>();

  public updateData(actions: Immutable<UpdateDataAction[]>): void {
    for (const action of actions) {
      this.#applyAction(action);
    }
  }

  #applyAction(action: Immutable<UpdateDataAction>): void {
    switch (action.type) {
      case "reset": {
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

    // console.log("down", viewport);

    const datasets: Dataset[] = [];
    for (const series of this.#seriesByMessagePath.values()) {
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

      const combinedSeries = series.full; // fixme - series.full.concat(series.current);

      let startIdx = 0;
      let endIdx = combinedSeries.length;

      for (let i = 0; i < combinedSeries.length; ++i) {
        const item = combinedSeries[i]!;
        if (item.x < viewport.bounds.x.min) {
          startIdx = i;
        }
        if (item.x > viewport.bounds.x.max) {
          endIdx = i;
          break;
        }
      }

      const items = combinedSeries.slice(startIdx, endIdx + 1);

      // fixme - wtf why does downsampling need this shit?
      let idx = 0;
      for (const item of combinedSeries) {
        item.index = idx++;
      }

      // fixme - max points argument
      const downsampledIndicies = downsampleTimeseries(items, {
        width: viewport.size.width,
        height: viewport.size.height,
        bounds: viewport.bounds,
      });

      // console.log(combinedSeries.length, downsampledIndicies.length);

      // When a series is downsampled the points are disabled as a visual indicator that
      // data is downsampled.
      if (downsampledIndicies.length < items.length) {
        dataset.pointRadius = 0;
      }

      for (const index of downsampledIndicies) {
        const item = combinedSeries[index];
        if (!item) {
          continue;
        }

        dataset.data.push(item);
      }

      datasets.push(dataset);
    }

    return datasets;
  }
}
