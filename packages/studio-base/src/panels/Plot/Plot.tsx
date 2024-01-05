// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { Button, Tooltip, Fade, buttonClasses } from "@mui/material";
import Hammer from "hammerjs";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { makeStyles } from "tss-react/mui";
import { v4 as uuidv4 } from "uuid";

import { debouncePromise } from "@foxglove/den/async";
import { filterMap } from "@foxglove/den/collection";
import { add as addTimes, fromSec } from "@foxglove/rostime";
import { Immutable } from "@foxglove/studio";
import parseRosPath from "@foxglove/studio-base/components/MessagePathSyntax/parseRosPath";
import { fillInGlobalVariablesInPath } from "@foxglove/studio-base/components/MessagePathSyntax/useCachedGetMessagePathDataItems";
import {
  MessagePipelineContext,
  useMessagePipeline,
  useMessagePipelineGetter,
  useMessagePipelineSubscribe,
} from "@foxglove/studio-base/components/MessagePipeline";
import { usePanelContext } from "@foxglove/studio-base/components/PanelContext";
import {
  PanelContextMenu,
  PanelContextMenuItem,
} from "@foxglove/studio-base/components/PanelContextMenu";
import PanelToolbar, {
  PANEL_TOOLBAR_MIN_HEIGHT,
} from "@foxglove/studio-base/components/PanelToolbar";
import Stack from "@foxglove/studio-base/components/Stack";
import TimeBasedChartTooltipContent, {
  TimeBasedChartTooltipData,
} from "@foxglove/studio-base/components/TimeBasedChart/TimeBasedChartTooltipContent";
import { Bounds1D } from "@foxglove/studio-base/components/TimeBasedChart/types";
import {
  TimelineInteractionStateStore,
  useClearHoverValue,
  useSetHoverValue,
  useTimelineInteractionState,
} from "@foxglove/studio-base/context/TimelineInteractionStateContext";
import useGlobalVariables from "@foxglove/studio-base/hooks/useGlobalVariables";
import { SubscribePayload } from "@foxglove/studio-base/players/types";
import { SaveConfig } from "@foxglove/studio-base/types/panels";
import { PANEL_TITLE_CONFIG_KEY } from "@foxglove/studio-base/util/layout";
import { getLineColor } from "@foxglove/studio-base/util/plotColors";

import { HoverValue } from "./HoverValue";
import { PlotCoordinator } from "./PlotCoordinator";
import { PlotLegend } from "./PlotLegend";
import { downloadCSV } from "./csv";
import { usePlotPanelSettings } from "./settings";
import { pathToPayload } from "./subscription";
import { PlotConfig } from "./types";

export const defaultSidebarDimension = 240;

const EmptyPaths: string[] = [];

const useStyles = makeStyles()((theme) => ({
  tooltip: {
    maxWidth: "none",
  },
  resetZoomButton: {
    pointerEvents: "none",
    position: "absolute",
    display: "flex",
    justifyContent: "flex-end",
    paddingInline: theme.spacing(1),
    right: 0,
    left: 0,
    bottom: 0,
    width: "100%",
    paddingBottom: theme.spacing(4),

    [`.${buttonClasses.root}`]: {
      pointerEvents: "auto",
    },
  },
  canvasDiv: { width: "100%", height: "100%", overflow: "hidden", cursor: "crosshair" },
}));

type Props = {
  config: PlotConfig;
  saveConfig: SaveConfig<PlotConfig>;
};

type ElementAtPixelArgs = {
  clientX: number;
  clientY: number;
  canvasX: number;
  canvasY: number;
};

const selectGlobalBounds = (store: TimelineInteractionStateStore) => store.globalBounds;
const selectSetGlobalBounds = (store: TimelineInteractionStateStore) => store.setGlobalBounds;

export function Plot(props: Props): JSX.Element {
  const { saveConfig, config } = props;
  const {
    title: legacyTitle,
    paths: series,
    showLegend,
    legendDisplay = config.showSidebar === true ? "left" : "floating",
    sidebarDimension = config.sidebarWidth ?? defaultSidebarDimension,
    [PANEL_TITLE_CONFIG_KEY]: customTitle,
  } = config;

  const { classes } = useStyles();

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

  // Migrate legacy Plot-specific title setting to new global title setting
  // https://github.com/foxglove/studio/pull/5225
  useEffect(() => {
    if (legacyTitle && (customTitle == undefined || customTitle === "")) {
      saveConfig({
        title: undefined,
        [PANEL_TITLE_CONFIG_KEY]: legacyTitle,
      } as Partial<PlotConfig>);
    }
  }, [customTitle, legacyTitle, saveConfig]);

  const [focusedPath, setFocusedPath] = useState<undefined | string[]>(undefined);
  const [subscriberId] = useState(() => uuidv4());
  const [canvasDiv, setCanvasDiv] = useState<HTMLDivElement | ReactNull>(ReactNull);
  const [coordinator, setCoordinator] = useState<PlotCoordinator | undefined>(undefined);
  const [showReset, setShowReset] = useState(false);

  const [activeTooltip, setActiveTooltip] = useState<{
    x: number;
    y: number;
    data: TimeBasedChartTooltipData[];
  }>();

  usePlotPanelSettings(config, saveConfig, focusedPath);

  const setHoverValue = useSetHoverValue();
  const clearHoverValue = useClearHoverValue();

  const onClickPath = useCallback((index: number) => {
    setFocusedPath(["paths", String(index)]);
  }, []);

  const getMessagePipelineState = useMessagePipelineGetter();
  const xAxisVal = config.xAxisVal;
  const onClick = useCallback(
    (event: React.MouseEvent<HTMLElement>): void => {
      // Only timestamp plots support click-to-seek
      if (xAxisVal !== "timestamp" || !coordinator) {
        return;
      }

      const {
        seekPlayback,
        playerState: { activeData: { startTime: start } = {} },
      } = getMessagePipelineState();

      if (!seekPlayback || !start) {
        return;
      }

      const rect = event.currentTarget.getBoundingClientRect();
      const mouseX = event.clientX - rect.left;

      const seekSeconds = coordinator.getXValueAtPixel(mouseX);
      // Avoid normalizing a negative time if the clicked point had x < 0.
      if (seekSeconds >= 0) {
        seekPlayback(addTimes(start, fromSec(seekSeconds)));
      }
    },
    [coordinator, getMessagePipelineState, xAxisVal],
  );

  const getPanelContextMenuItems = useCallback(() => {
    const items: PanelContextMenuItem[] = [
      {
        type: "item",
        label: "Download plot data as CSV",
        onclick: async () => {
          const data = await coordinator?.getCsvData();
          if (!data) {
            return;
          }

          downloadCSV(customTitle ?? "plot_data", data, xAxisVal);
        },
      },
    ];
    return items;
  }, [coordinator, customTitle, xAxisVal]);

  const setSubscriptions = useMessagePipeline(
    useCallback(
      ({ setSubscriptions: pipelineSetSubscriptions }: MessagePipelineContext) =>
        pipelineSetSubscriptions,
      [],
    ),
  );
  const subscribeMessasagePipeline = useMessagePipelineSubscribe();

  const { globalVariables } = useGlobalVariables();

  useEffect(() => {
    coordinator?.handleConfig(config, globalVariables);
  }, [coordinator, config, globalVariables]);

  useEffect(() => {
    if (!canvasDiv) {
      return;
    }
    const canvas = document.createElement("canvas");
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvasDiv.appendChild(canvas);

    if (typeof canvas.transferControlToOffscreen !== "function") {
      throw new Error("Offscreen rendering is not supported");
    }

    const offscreenCanvas = canvas.transferControlToOffscreen();
    const plotCoordinator = new PlotCoordinator(offscreenCanvas);
    setCoordinator(plotCoordinator);

    const unsub = subscribeMessasagePipeline((state) => {
      plotCoordinator.handlePlayerState(state.playerState);
    });

    // Subscribing only gets us _new_ updates, so we feed the latest state into the chart
    plotCoordinator.handlePlayerState(getMessagePipelineState().playerState);

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target !== canvasDiv) {
          continue;
        }

        plotCoordinator.setSize({
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        });
      }
    });
    resizeObserver.observe(canvasDiv);

    return () => {
      unsub();
      resizeObserver.disconnect();
      plotCoordinator.terminate();
      canvasDiv.removeChild(canvas);
    };
  }, [canvasDiv, getMessagePipelineState, subscribeMessasagePipeline]);

  const onWheel = useCallback(
    async (event: React.WheelEvent<HTMLElement>) => {
      if (!coordinator) {
        return;
      }

      const boundingRect = event.currentTarget.getBoundingClientRect();
      coordinator.addInteractionEvent({
        type: "wheel",
        cancelable: false,
        deltaY: event.deltaY,
        deltaX: event.deltaX,
        clientX: event.clientX,
        clientY: event.clientY,
        boundingClientRect: boundingRect.toJSON(),
      });
      setShowReset(true);
    },
    [coordinator],
  );

  const [buildTooltip, setBuildTooltip] = useState<
    ((args: ElementAtPixelArgs) => void) | undefined
  >(undefined);

  const mousePresentRef = useRef(false);

  useEffect(() => {
    const moveHandler = debouncePromise(async (args: ElementAtPixelArgs) => {
      const elements = await coordinator?.getElementsAtPixel({
        x: args.canvasX,
        y: args.canvasY,
      });

      if (!elements || elements.length === 0 || !mousePresentRef.current) {
        setActiveTooltip(undefined);
        return;
      }

      const tooltipItems: TimeBasedChartTooltipData[] = [];

      for (const element of elements) {
        tooltipItems.push({
          datasetIndex: element.datasetIndex,
          value: element.data.y,
        });
      }

      if (tooltipItems.length === 0) {
        setActiveTooltip(undefined);
        return;
      }

      setActiveTooltip({
        x: args.clientX,
        y: args.clientY,
        data: tooltipItems,
      });
    });

    setBuildTooltip(() => {
      return moveHandler;
    });
    return () => {
      setBuildTooltip(undefined);
    };
  }, [coordinator]);

  // Extract the bounding client rect from currentTarget before calling the debounced function
  // because react re-uses the SyntheticEvent objects.
  const onMouseMove = useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      mousePresentRef.current = true;
      const boundingRect = event.currentTarget.getBoundingClientRect();
      buildTooltip?.({
        clientX: event.clientX,
        clientY: event.clientY,
        canvasX: event.clientX - boundingRect.left,
        canvasY: event.clientY - boundingRect.top,
      });

      // Only timestamp plots support setting the global hover value
      if (xAxisVal !== "timestamp" || !coordinator) {
        return;
      }

      const rect = event.currentTarget.getBoundingClientRect();
      const mouseX = event.clientX - rect.left;
      const seconds = coordinator.getXValueAtPixel(mouseX);

      setHoverValue({
        componentId: subscriberId,
        value: seconds,
        type: "PLAYBACK_SECONDS",
      });
    },
    [buildTooltip, coordinator, setHoverValue, subscriberId, xAxisVal],
  );

  // Looking up a tooltip is an async operation so the mouse might leave while the component while
  // that is happening and we need to avoid showing a tooltip.
  const onMouseOut = useCallback(() => {
    mousePresentRef.current = false;
    setActiveTooltip(undefined);
    clearHoverValue(subscriberId);
  }, [clearHoverValue, subscriberId]);

  const { colorsByDatasetIndex, labelsByDatasetIndex } = useMemo(() => {
    const labels: Record<string, string> = {};
    const colors: Record<string, string> = {};

    for (let idx = 0; idx < config.paths.length; ++idx) {
      const item = config.paths[idx]!;
      labels[idx] = item.label ?? item.value;
      colors[idx] = getLineColor(item.color, idx);
    }

    return {
      colorsByDatasetIndex: colors,
      labelsByDatasetIndex: labels,
    };
  }, [config.paths]);

  const numSeries = config.paths.length;
  const tooltipContent = useMemo(() => {
    return activeTooltip ? (
      <TimeBasedChartTooltipContent
        content={activeTooltip.data}
        multiDataset={numSeries > 0}
        colorsByDatasetIndex={colorsByDatasetIndex}
        labelsByDatasetIndex={labelsByDatasetIndex}
      />
    ) : undefined;
  }, [activeTooltip, colorsByDatasetIndex, labelsByDatasetIndex, numSeries]);

  useEffect(() => {
    if (!canvasDiv || !coordinator) {
      return;
    }

    const hammerManager = new Hammer.Manager(canvasDiv);
    const threshold = 10;
    hammerManager.add(new Hammer.Pan({ threshold }));

    hammerManager.on("panstart", async (event) => {
      const boundingRect = event.target.getBoundingClientRect();
      coordinator.addInteractionEvent({
        type: "panstart",
        cancelable: false,
        deltaY: event.deltaY,
        deltaX: event.deltaX,
        center: {
          x: event.center.x,
          y: event.center.y,
        },
        boundingClientRect: boundingRect.toJSON(),
      });
    });

    hammerManager.on("panmove", async (event) => {
      const boundingRect = event.target.getBoundingClientRect();
      coordinator.addInteractionEvent({
        type: "panmove",
        cancelable: false,
        deltaY: event.deltaY,
        deltaX: event.deltaX,
        boundingClientRect: boundingRect.toJSON(),
      });
    });

    hammerManager.on("panend", async (event) => {
      setShowReset(true);
      const boundingRect = event.target.getBoundingClientRect();
      coordinator.addInteractionEvent({
        type: "panend",
        cancelable: false,
        deltaY: event.deltaY,
        deltaX: event.deltaX,
        boundingClientRect: boundingRect.toJSON(),
      });
    });

    return () => {
      hammerManager.destroy();
    };
  }, [canvasDiv, coordinator]);

  // We could subscribe in the chart renderer, but doing it with react effects is easier for
  // managing the lifecycle of the subscriptions. The renderer will correlate input message data to
  // the correct series.
  useEffect(() => {
    // fixme - xAxisPath

    // fixme
    // for x-axis: msg path (current) - we render only the latest message data
    // this is a simplified flow that does not need downsampling or full subscriptions
    // and we can handle it entirely here

    const subscriptions = filterMap(series, (item): SubscribePayload | undefined => {
      const parsed = parseRosPath(item.value);
      if (!parsed) {
        return;
      }

      // fixme - a path like /mcnasty/position. resulted in a subscription with an "" empty field name
      // in fact this path should be invalid

      return pathToPayload(fillInGlobalVariablesInPath(parsed, globalVariables));
    });
    setSubscriptions(subscriberId, subscriptions);
  }, [series, setSubscriptions, subscriberId, globalVariables]);

  const globalBounds = useTimelineInteractionState(selectGlobalBounds);
  const setGlobalBounds = useTimelineInteractionState(selectSetGlobalBounds);

  const shouldSync = config.xAxisVal === "timestamp" && config.isSynced;

  useEffect(() => {
    if (globalBounds?.sourceId === subscriberId || !shouldSync) {
      return;
    }

    coordinator?.setTimeseriesBounds({
      min: globalBounds?.min,
      max: globalBounds?.max,
    });
  }, [coordinator, globalBounds, shouldSync, subscriberId]);

  useEffect(() => {
    if (!coordinator || !shouldSync) {
      return;
    }

    const onTimeseriesBounds = (newBounds: Immutable<Bounds1D>) => {
      setGlobalBounds({
        min: newBounds.min,
        max: newBounds.max,
        sourceId: subscriberId,
        userInteraction: true,
      });
    };
    coordinator.on("timeseriesBounds", onTimeseriesBounds);
    return () => {
      coordinator.off("timeseriesBounds", onTimeseriesBounds);
    };
  }, [coordinator, setGlobalBounds, shouldSync, subscriberId]);

  const onResetView = useCallback(() => {
    setShowReset(false);
    coordinator?.resetBounds();

    if (shouldSync) {
      setGlobalBounds(undefined);
    }
  }, [coordinator, setGlobalBounds, shouldSync]);

  const valuesBySeriesIndex = useMemo(() => {
    if (!config.showPlotValuesInLegend) {
      return;
    }

    if (!activeTooltip?.data) {
      return;
    }

    const values = new Array(config.paths.length).fill(undefined);
    for (const item of activeTooltip.data) {
      values[item.datasetIndex] ??= item.value;
    }

    return values;
  }, [activeTooltip, config.paths.length, config.showPlotValuesInLegend]);

  // The reset view button is shown when we have interacted locally or if the global bounds are set
  // and we are sync'd.
  const showResetViewButton = showReset || (globalBounds != undefined && shouldSync);

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
        direction={legendDisplay === "top" ? "column" : "row"}
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
            sidebarDimension={sidebarDimension}
            valuesBySeriesIndex={valuesBySeriesIndex}
          />
        )}
        {showResetViewButton && (
          <div className={classes.resetZoomButton}>
            <Button
              variant="contained"
              color="inherit"
              title="(shortcut: double-click)"
              onClick={onResetView}
            >
              Reset view
            </Button>
          </div>
        )}
        <Tooltip
          arrow={false}
          classes={{ tooltip: classes.tooltip }}
          open={tooltipContent != undefined}
          placement="right"
          title={tooltipContent ?? <></>}
          disableInteractive
          followCursor
          TransitionComponent={Fade}
          TransitionProps={{ timeout: 0 }}
        >
          <div
            className={classes.canvasDiv}
            ref={setCanvasDiv}
            onWheel={onWheel}
            onMouseMove={onMouseMove}
            onMouseOut={onMouseOut}
            onClick={onClick}
          />
        </Tooltip>
        <PanelContextMenu getItems={getPanelContextMenuItems} />
      </Stack>
      <HoverValue coordinator={coordinator} />
    </Stack>
  );
}
