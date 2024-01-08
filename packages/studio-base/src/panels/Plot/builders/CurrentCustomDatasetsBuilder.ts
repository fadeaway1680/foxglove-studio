// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { ChartDataset } from "chart.js";

import { toSec, isTime } from "@foxglove/rostime";
import { Immutable, Time } from "@foxglove/studio";
import { RosPath } from "@foxglove/studio-base/components/MessagePathSyntax/constants";
import parseRosPath from "@foxglove/studio-base/components/MessagePathSyntax/parseRosPath";
import { simpleGetMessagePathDataItems } from "@foxglove/studio-base/components/MessagePathSyntax/simpleGetMessagePathDataItems";
import { fillInGlobalVariablesInPath } from "@foxglove/studio-base/components/MessagePathSyntax/useCachedGetMessagePathDataItems";
import { Bounds1D } from "@foxglove/studio-base/components/TimeBasedChart/types";
import { GlobalVariables } from "@foxglove/studio-base/hooks/useGlobalVariables";
import { PlayerState } from "@foxglove/studio-base/players/types";
import { getLineColor } from "@foxglove/studio-base/util/plotColors";

import { CsvDataset, IDatasetsBuilder } from "./IDatasetsBuilder";
import { Dataset } from "../ChartRenderer";
import { Datum, isReferenceLinePlotPathType } from "../internalTypes";
import { PlotConfig } from "../types";

type DatumWithReceiveTime = Datum & {
  receiveTime: Time;
};

type SeriesItem = {
  enabled: boolean;
  messagePath: string;
  parsed: RosPath;
  dataset: ChartDataset<"scatter", DatumWithReceiveTime[]>;
};

export class CurrentCustomDatasetsBuilder implements IDatasetsBuilder {
  #parsedPath?: Immutable<RosPath>;

  #xValues: number[] = [];

  #seriesByMessagePath = new Map<string, SeriesItem>();

  #range: Bounds1D = { min: 0, max: 0 };

  public handlePlayerState(state: Immutable<PlayerState>): Bounds1D | undefined {
    const activeData = state.activeData;
    if (!activeData || !this.#parsedPath) {
      return;
    }

    const msgEvents = activeData.messages;
    if (msgEvents.length === 0) {
      return;
    }

    for (let i = msgEvents.length - 1; i >= 0; --i) {
      const msgEvent = msgEvents[i]!;
      if (msgEvent.topic !== this.#parsedPath.topicName) {
        continue;
      }

      const items = simpleGetMessagePathDataItems(msgEvent, this.#parsedPath);

      this.#xValues = [];
      for (const item of items) {
        const chartValue = getChartValue(item);
        if (chartValue == undefined) {
          continue;
        }

        this.#range.min = Math.min(chartValue, this.#range.min);
        this.#range.max = Math.max(chartValue, this.#range.max);
        this.#xValues.push(chartValue);
      }

      break;
    }

    if (this.#xValues.length === 0) {
      return;
    }

    const range: Bounds1D = { min: 0, max: 0 };
    for (const series of this.#seriesByMessagePath.values()) {
      // loop over the events backwards and once we find our first matching topic
      // read that for the path items
      for (let i = msgEvents.length - 1; i >= 0; --i) {
        const msgEvent = msgEvents[i]!;
        if (msgEvent.topic !== series.parsed.topicName) {
          continue;
        }

        const items = simpleGetMessagePathDataItems(msgEvent, series.parsed);
        const pathItems = items.map((item, idx) => {
          const chartValue = getChartValue(item);

          return {
            x: this.#xValues[idx] ?? NaN,
            y: chartValue ?? NaN,
            receiveTime: msgEvent.receiveTime,
          };
        });

        series.dataset.data = pathItems;

        break;
      }

      range.max = Math.max(range.max, series.dataset.data.length);
    }

    return range;
  }

  public setXPath(path: Immutable<RosPath> | undefined): void {
    if (JSON.stringify(path) === JSON.stringify(this.#parsedPath)) {
      return;
    }

    // When the x-path changes we clear any existing data from the datasets
    this.#parsedPath = path;
    for (const series of this.#seriesByMessagePath.values()) {
      series.dataset.data = [];
    }
  }

  public setConfig(config: Immutable<PlotConfig>, globalVariables: GlobalVariables): void {
    // Make a new map so we drop series which are no longer present
    const newSeries = new Map();

    let idx = 0;
    for (const path of config.paths) {
      if (isReferenceLinePlotPathType(path)) {
        continue;
      }

      const parsed = parseRosPath(path.value);
      if (!parsed) {
        continue;
      }

      const filledParsed = fillInGlobalVariablesInPath(parsed, globalVariables);

      let existingSeries = this.#seriesByMessagePath.get(path.value);
      if (!existingSeries) {
        existingSeries = {
          enabled: path.enabled,
          messagePath: path.value,
          parsed: filledParsed,
          dataset: {
            data: [],
          },
        };
      }

      const color = getLineColor(path.color, idx);
      const lineSize = path.lineSize ?? 1.0;

      existingSeries.dataset = {
        ...existingSeries.dataset,
        borderColor: color,
        showLine: path.showLine,
        fill: false,
        borderWidth: lineSize,
        pointRadius: lineSize * 1.2,
        pointHoverRadius: 3,
        pointBackgroundColor: color,
        pointBorderColor: "transparent",
      };

      newSeries.set(path.value, existingSeries);
      idx += 1;
    }
    this.#seriesByMessagePath = newSeries;
  }

  public async getViewportDatasets(): Promise<Dataset[]> {
    const datasets: Dataset[] = [];
    for (const series of this.#seriesByMessagePath.values()) {
      if (!series.enabled) {
        continue;
      }

      datasets.push(series.dataset);
    }

    return datasets;
  }

  public async getCsvData(): Promise<CsvDataset[]> {
    const datasets: CsvDataset[] = [];
    for (const series of this.#seriesByMessagePath.values()) {
      if (!series.enabled) {
        continue;
      }

      datasets.push({
        label: series.messagePath,
        data: series.dataset.data,
      });
    }

    return datasets;
  }

  public destroy(): void {
    // no-op this builder does not use a worker
  }
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
