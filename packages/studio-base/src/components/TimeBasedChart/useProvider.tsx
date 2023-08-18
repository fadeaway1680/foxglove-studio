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

import { ChartDataset, ChartData } from "chart.js";
import * as React from "react";
import * as R from "ramda";

import { iterateNormal, iterateTyped } from "@foxglove/studio-base/components/Chart/datasets";
import type { ObjectData, TypedData } from "@foxglove/studio-base/components/Chart/types";

import { Provider, ProviderState, Bounds, View } from "./types";

type Datasets<T> = ChartDataset<"scatter", T>[];
type Data<T> = ChartData<"scatter", T>;

export function getBounds(data: Datasets<ObjectData>): Bounds | undefined {
  let xMin: number | undefined;
  let xMax: number | undefined;
  let yMin: number | undefined;
  let yMax: number | undefined;

  for (const dataset of data) {
    for (const item of iterateNormal(dataset.data)) {
      if (!isNaN(item.x)) {
        xMin = Math.min(xMin ?? item.x, item.x);
        xMax = Math.max(xMax ?? item.x, item.x);
      }

      if (!isNaN(item.x)) {
        yMin = Math.min(yMin ?? item.y, item.y);
        yMax = Math.max(yMax ?? item.y, item.y);
      }
    }
  }

  if (xMin == undefined || xMax == undefined || yMin == undefined || yMax == undefined) {
    return undefined;
  }

  return { x: { min: xMin, max: xMax }, y: { min: yMin, max: yMax } };
}

export function getTypedBounds(data: Datasets<TypedData[]>): Bounds | undefined {
  let xMin: number | undefined;
  let xMax: number | undefined;
  let yMin: number | undefined;
  let yMax: number | undefined;

  for (const dataset of data) {
    for (const item of iterateTyped(dataset.data)) {
      const { x, y } = item;

      if (!isNaN(x)) {
        xMin = Math.min(xMin ?? x, x);
        xMax = Math.max(xMax ?? x, x);
      }

      if (!isNaN(y)) {
        yMin = Math.min(yMin ?? y, y);
        yMax = Math.max(yMax ?? y, y);
      }
    }
  }

  if (xMin == undefined || xMax == undefined || yMin == undefined || yMax == undefined) {
    return undefined;
  }

  return { x: { min: xMin, max: xMax }, y: { min: yMin, max: yMax } };
}

function mergeBounds(a: Bounds, b: Bounds): Bounds {
  return {
    x: {
      min: R.min(a.x.min, b.x.min),
      max: R.max(a.x.max, b.x.max),
    },
    y: {
      min: R.min(a.y.min, b.y.min),
      max: R.max(a.y.max, b.y.max),
    },
  };
}

type State<T> = ProviderState<T>;
type Dataset<T> = Datasets<T>[0];
// Given a merging strategy, `makeMerge` returns a function that can be used to
// merge `ProviderState`s.
const makeMerge =
  <T,>(mergeData: (dataA: T, dataB: T) => T) =>
  (a: State<T>, b: State<T>): State<T> => {
    return {
      bounds: mergeBounds(a.bounds, b.bounds),
      data: {
        datasets: R.map(
          ([aSet, bSet]: [Dataset<T>, Dataset<T>]): Dataset<T> => ({
            data: mergeData(aSet.data, bSet.data),
          }),
          R.zip(a.data.datasets, b.data.datasets),
        ),
      },
    };
  };

export const mergeNormal = makeMerge<ObjectData>((a: ObjectData, b: ObjectData) => [...a, ...b]);
export const mergeTyped = makeMerge<TypedData[]>((a: TypedData[], b: TypedData[]) => [...a, ...b]);

type DataState<T> = {
  full: ProviderState<T> | undefined;
  partial: ProviderState<T> | undefined;
};

export default function useProvider<T>(
  view: View,
  // Calculates the bounds of the given datasets.
  getDatasetBounds: (data: Datasets<T>) => Bounds | undefined,
  mergeState: (a: ProviderState<T>, b: ProviderState<T>) => ProviderState<T>,
  data: Data<T> | undefined,
  provider: Provider<T> | undefined,
): ProviderState<T> | undefined {
  const [state, setState] = React.useState<DataState<T> | undefined>();

  const setFull = React.useCallback((newFull: ProviderState<T>) => {
    setState({
      full: newFull,
      partial: undefined,
    });
  }, []);

  const addPartial = React.useCallback((newPartial: ProviderState<T>) => {
    setState((oldState) => {
      if (oldState == undefined) {
        return {
          full: undefined,
          partial: newPartial,
        };
      }

      const { partial: oldPartial } = oldState;

      return {
        ...oldState,
        partial: oldPartial != undefined ? mergeState(oldPartial, newPartial) : newPartial,
      };
    });
  }, []);

  React.useEffect(() => {
    if (provider == undefined) {
      return;
    }
    provider.register(setFull, addPartial);
  }, [provider, addPartial]);

  React.useEffect(() => {
    if (provider == undefined) {
      return;
    }
    provider.setView(view);
  }, [provider, view]);

  return React.useMemo(() => {
    if (data == undefined) {
      if (state == undefined) {
        return undefined;
      }

      const { full, partial } = state;
      if (partial == undefined) {
        return full;
      }

      if (full == undefined) {
        return undefined;
      }

      return mergeState(full, partial);
    }

    const bounds = getDatasetBounds(data.datasets);
    if (bounds == undefined) {
      return undefined;
    }

    return {
      bounds,
      data,
    };
  }, [data, state, getDatasetBounds]);
}
