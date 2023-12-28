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

import { useCallback, useEffect, useMemo, useState } from "react";

import { useMessagePipelineSubscribe } from "@foxglove/studio-base/components/MessagePipeline";
import Panel from "@foxglove/studio-base/components/Panel";
import { usePanelContext } from "@foxglove/studio-base/components/PanelContext";
import PanelToolbar, {
  PANEL_TOOLBAR_MIN_HEIGHT,
} from "@foxglove/studio-base/components/PanelToolbar";
import Stack from "@foxglove/studio-base/components/Stack";
import { SaveConfig } from "@foxglove/studio-base/types/panels";
import { PANEL_TITLE_CONFIG_KEY } from "@foxglove/studio-base/util/layout";

import { ChartRenderer } from "./ChartRenderer";
import { PlotLegend } from "./PlotLegend";
import { usePlotPanelSettings } from "./settings";
import { PlotConfig } from "./types";

const defaultSidebarDimension = 240;

const EmptyPaths: string[] = [];

type Props = {
  config: PlotConfig;
  saveConfig: SaveConfig<PlotConfig>;
};

function Plot(props: Props) {
  const { saveConfig, config } = props;
  const {
    title: legacyTitle,
    paths: series,
    showLegend,
    legendDisplay = config.showSidebar === true ? "left" : "floating",
    showPlotValuesInLegend,
    sidebarDimension = config.sidebarWidth ?? defaultSidebarDimension,
    [PANEL_TITLE_CONFIG_KEY]: customTitle,
  } = config;

  const { setMessagePathDropConfig } = usePanelContext();

  useEffect(() => {
    setMessagePathDropConfig({
      getDropStatus(paths) {
        if (paths.some((path) => !path.isLeaf)) {
          return { canDrop: false };
        }
        return { canDrop: true, effect: "add" };
      },
      handleDrop(paths) {
        saveConfig((prevConfig) => ({
          ...prevConfig,
          paths: [
            ...prevConfig.paths,
            ...paths.map((path) => ({
              value: path.path,
              enabled: true,
              timestampMethod: "receiveTime" as const,
            })),
          ],
        }));
      },
    });
  }, [saveConfig, setMessagePathDropConfig]);

  useEffect(() => {
    if (legacyTitle && (customTitle == undefined || customTitle === "")) {
      // Migrate legacy Plot-specific title setting to new global title setting
      // https://github.com/foxglove/studio/pull/5225
      saveConfig({
        title: undefined,
        [PANEL_TITLE_CONFIG_KEY]: legacyTitle,
      } as Partial<PlotConfig>);
    }
  }, [customTitle, legacyTitle, saveConfig]);

  const [focusedPath, setFocusedPath] = useState<undefined | string[]>(undefined);

  usePlotPanelSettings(config, saveConfig, focusedPath);

  const stackDirection = useMemo(
    () => (legendDisplay === "top" ? "column" : "row"),
    [legendDisplay],
  );

  const onClickPath = useCallback((index: number) => {
    setFocusedPath(["paths", String(index)]);
  }, []);

  /*
  // Min/max x-values and playback position indicator are only used for preloaded plots. In non-
  // preloaded plots min x-value is always the last seek time, and the max x-value is the current
  // playback time.
  const timeSincePreloadedStart = (time?: Time): number | undefined => {
    if (xAxisVal === "timestamp" && time && startTime) {
      return toSec(subtractTimes(time, startTime));
    }
    return undefined;
  };

  const followingView = useMemo<ChartDefaultView | undefined>(() => {
    if (followingViewWidth != undefined && +followingViewWidth > 0) {
      return { type: "following", width: +followingViewWidth };
    }
    return undefined;
  }, [followingViewWidth]);

  const fixedView = useMemo<ChartDefaultView | undefined>(() => {
    // Apply min/max x-value if either min or max or both is defined.
    if ((_.isNumber(minXValue) && _.isNumber(endTimeSinceStart)) || _.isNumber(maxXValue)) {
      return {
        type: "fixed",
        minXValue: _.isNumber(minXValue) ? minXValue : 0,
        maxXValue: _.isNumber(maxXValue) ? maxXValue : endTimeSinceStart ?? 0,
      };
    }
    if (xAxisVal === "timestamp" && startTime && endTimeSinceStart != undefined) {
      return { type: "fixed", minXValue: 0, maxXValue: endTimeSinceStart };
    }
    return undefined;
  }, [maxXValue, minXValue, endTimeSinceStart, startTime, xAxisVal]);

  // following view and fixed view are split to keep defaultView identity stable when possible
  const defaultView = useMemo<ChartDefaultView | undefined>(() => {
    return followingView ?? fixedView ?? undefined;
  }, [fixedView, followingView]);

  const messagePipeline = useMessagePipelineGetter();
  const onClick = useCallback<NonNullable<ComponentProps<typeof PlotChart>["onClick"]>>(
    ({ x: seekSeconds }: OnChartClickArgs) => {
      const {
        seekPlayback,
        playerState: { activeData: { startTime: start } = {} },
      } = messagePipeline();
      if (!seekPlayback || !start || seekSeconds == undefined || xAxisVal !== "timestamp") {
        return;
      }
      // Avoid normalizing a negative time if the clicked point had x < 0.
      if (seekSeconds >= 0) {
        seekPlayback(addTimes(start, fromSec(seekSeconds)));
      }
    },
    [messagePipeline, xAxisVal],
  );


  const getPanelContextMenuItems = useCallback(() => {
    const items: PanelContextMenuItem[] = [
      {
        type: "item",
        label: "Download plot data as CSV",
        onclick: async () => {
          // Because the full dataset is never in the rendering thread, we have to request it from the worker.
          const data = await getFullData();
          if (data == undefined) {
            return;
          }
          const csvDatasets = [];
          for (const dataset of data.datasets.values()) {
            csvDatasets.push(dataset);
          }
          downloadCSV(csvDatasets, xAxisVal);
        },
      },
    ];
    return items;
  }, [getFullData, xAxisVal]);
*/

  const [canvasDiv, setCanvasDiv] = useState<HTMLDivElement | ReactNull>(ReactNull);
  const [chartRenderer, setChartRender] = useState<ChartRenderer | undefined>(undefined);

  const subscribeMessasagePipeline = useMessagePipelineSubscribe();

  useEffect(() => {
    if (!canvasDiv) {
      return;
    }
    const canvas = document.createElement("canvas");
    canvas.style.width = "100%";
    canvasDiv.appendChild(canvas);

    const renderer = new ChartRenderer(canvas);
    setChartRender(renderer);
    const unsub = subscribeMessasagePipeline(renderer.update.bind(renderer));

    return () => {
      unsub();
      renderer.terminate();
      canvasDiv.removeChild(canvasDiv);
    };
  }, [canvasDiv, subscribeMessasagePipeline]);

  // subscribe?
  // why do it in the chart stuff and not here?
  // we can also compute the message path functions here?

  useEffect(() => {
    chartRenderer?.updateConfig(config);
  }, [chartRenderer, config]);

  return (
    <Stack
      flex="auto"
      alignItems="center"
      justifyContent="center"
      overflow="hidden"
      position="relative"
    >
      <PanelToolbar />
      <Stack
        direction={stackDirection}
        flex="auto"
        fullWidth
        style={{ height: `calc(100% - ${PANEL_TOOLBAR_MIN_HEIGHT}px)` }}
        position="relative"
      >
        {/* Pass stable values here for properties when not showing values so that the legend memoization remains stable. */}
        {legendDisplay !== "none" && (
          <PlotLegend
            legendDisplay={legendDisplay}
            onClickPath={onClickPath}
            paths={series}
            pathsWithMismatchedDataLengths={EmptyPaths /* fixme */}
            saveConfig={saveConfig}
            showLegend={showLegend}
            showPlotValuesInLegend={showPlotValuesInLegend}
            sidebarDimension={sidebarDimension}
          />
        )}
        <Stack flex="auto" alignItems="center" justifyContent="center" overflow="hidden">
          <div ref={setCanvasDiv} />
        </Stack>
      </Stack>
    </Stack>
  );
}

const defaultConfig: PlotConfig = {
  paths: [],
  minYValue: undefined,
  maxYValue: undefined,
  showXAxisLabels: true,
  showYAxisLabels: true,
  showLegend: true,
  legendDisplay: "floating",
  showPlotValuesInLegend: false,
  isSynced: true,
  xAxisVal: "timestamp",
  sidebarDimension: defaultSidebarDimension,
};

export default Panel(
  Object.assign(Plot, {
    panelType: "Plot",
    defaultConfig,
  }),
);
