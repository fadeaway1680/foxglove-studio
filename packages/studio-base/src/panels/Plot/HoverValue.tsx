// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { useEffect } from "react";

import { useHoverValue } from "@foxglove/studio-base/context/TimelineInteractionStateContext";

import type { PlotCoordinator } from "./PlotCoordinator";

type Props = {
  coordinator?: PlotCoordinator;
  enabled: boolean;
};

/**
 * Apply the hover value to the chart.
 *
 * Since the hover value can update frequently on hover we use this component to contain the scope
 * of what will re-render when the value updates.
 */
export function HoverValue(props: Props): JSX.Element {
  const coordinator = props.coordinator;
  const enabled = props.enabled;

  const hoverValue = useHoverValue({
    disableUpdates: !enabled,
  });

  useEffect(() => {
    if (!hoverValue || hoverValue.type !== "PLAYBACK_SECONDS") {
      coordinator?.setHoverValue(undefined);
      return;
    }

    coordinator?.setHoverValue(hoverValue.value);
  }, [coordinator, hoverValue]);

  return <></>;
}
