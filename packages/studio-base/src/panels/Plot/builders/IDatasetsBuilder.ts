// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import type { Immutable, Time } from "@foxglove/studio";
import type { Bounds1D } from "@foxglove/studio-base/components/TimeBasedChart/types";
import { GlobalVariables } from "@foxglove/studio-base/hooks/useGlobalVariables";
import type { PlayerState } from "@foxglove/studio-base/players/types";

import type { Dataset } from "../ChartRenderer";
import { PlotConfig } from "../types";

type CsvDatum = {
  x: number;
  y: number;
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

export type CsvDataset = {
  label: string;
  data: CsvDatum[];
};

interface IDatasetsBuilder {
  handlePlayerState(state: Immutable<PlayerState>): Bounds1D | undefined;

  setConfig(config: Immutable<PlotConfig>, globalVariables: GlobalVariables): void;

  getViewportDatasets(viewport: Immutable<Viewport>): Promise<Dataset[]>;

  getCsvData(): Promise<CsvDataset[]>;

  destroy(): void;
}

export type { IDatasetsBuilder };
