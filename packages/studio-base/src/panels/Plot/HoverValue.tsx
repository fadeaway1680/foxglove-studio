// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { useEffect } from "react";

import { useHoverValue } from "@foxglove/studio-base/context/TimelineInteractionStateContext";

import type { PlotCoordinator } from "./PlotCoordinator";

type Props = {
  chartRenderer?: PlotCoordinator;
};

/**
 * Apply the hover value to the chart.
 *
 * Since the hover value can update frequently on hover we use this component to contain the scope
 * of what will re-render when the value updates.
 */
export function HoverValue(props: Props): JSX.Element {
  const chartRenderer = props.chartRenderer;

  const hoverValue = useHoverValue();
  useEffect(() => {
    if (!hoverValue || hoverValue.type !== "PLAYBACK_SECONDS") {
      chartRenderer?.setHoverValue(undefined);
      return;
    }

    chartRenderer?.setHoverValue(hoverValue.value);
  }, [chartRenderer, hoverValue]);

  return <></>;
}
