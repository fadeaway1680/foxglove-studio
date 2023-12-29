// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import {
  continueDownsample,
  finishDownsample,
  initDownsample,
} from "@foxglove/studio-base/components/TimeBasedChart/downsample";

/**
 * Downsampler provides downsampling for time series data in a chart. It keeps full resolution datums
 * for all series, downsamples for a target viewport as new data is added, and can re-downsample
 * if the viewport changes.
 */
class Downsampler {
  public constructor() {
    const downsampleState = initDownsample(view, maxPoints);

    const [indices, newState] = continueDownsample(newPoints, downsampleState);

    const [finalIndicies] = finishDownsample(newState);
  }

  public appendDatums(): void {}

  public getDownsampledDatasets(): void {}

  public setViewport(): void {}
}
