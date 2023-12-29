// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { Button, Tooltip, Fade, buttonClasses } from "@mui/material";
import Hammer from "hammerjs";
import * as R from "ramda";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { makeStyles } from "tss-react/mui";
import { v4 as uuidv4 } from "uuid";

import { debouncePromise } from "@foxglove/den/async";
import { filterMap } from "@foxglove/den/collection";
import { Immutable } from "@foxglove/studio";
import {
  MessagePathPart,
  RosPath,
} from "@foxglove/studio-base/components/MessagePathSyntax/constants";
import parseRosPath from "@foxglove/studio-base/components/MessagePathSyntax/parseRosPath";
import { fillInGlobalVariablesInPath } from "@foxglove/studio-base/components/MessagePathSyntax/useCachedGetMessagePathDataItems";
import {
  MessagePipelineContext,
  useMessagePipeline,
  useMessagePipelineSubscribe,
} from "@foxglove/studio-base/components/MessagePipeline";
import { usePanelContext } from "@foxglove/studio-base/components/PanelContext";
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
  useTimelineInteractionState,
} from "@foxglove/studio-base/context/TimelineInteractionStateContext";
import useGlobalVariables from "@foxglove/studio-base/hooks/useGlobalVariables";
import { SubscribePayload } from "@foxglove/studio-base/players/types";
import { SaveConfig } from "@foxglove/studio-base/types/panels";
import { PANEL_TITLE_CONFIG_KEY } from "@foxglove/studio-base/util/layout";

import { OffscreenCanvasRenderer } from "./OffscreenCanvasRenderer";
import { PlotLegend } from "./PlotLegend";
import { usePlotPanelSettings } from "./settings";
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
}));

type Props = {
  config: PlotConfig;
  saveConfig: SaveConfig<PlotConfig>;
};

const selectGlobalBounds = (store: TimelineInteractionStateStore) => store.globalBounds;
const selectSetGlobalBounds = (store: TimelineInteractionStateStore) => store.setGlobalBounds;

// fixme - separate file
// fixme - get rid of ramda
function pathToPayload(path: RosPath): SubscribePayload | undefined {
  const { messagePath: parts, topicName: topic } = path;

  // We want to take _all_ of the filters that start the path, since these can
  // be chained
  const filters = R.takeWhile((part: MessagePathPart) => part.type === "filter", parts);
  const firstField = parts.find((part: MessagePathPart) => part.type === "name");
  if (firstField == undefined || firstField.type !== "name") {
    return undefined;
  }

  return {
    topic,
    preloadType: "full",
    fields: R.pipe(
      R.chain((part: MessagePathPart): string[] => {
        if (part.type !== "filter") {
          return [];
        }
        const { path: filterPath } = part;
        const field = filterPath[0];
        if (field == undefined) {
          return [];
        }

        return [field];
      }),
      // Always subscribe to the header field
      (filterFields) => [...filterFields, firstField.name, "header"],
      R.uniq,
    )(filters),
  };
}

export function Plot(props: Props): JSX.Element {
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

  const onClickPath = useCallback((index: number) => {
    setFocusedPath(["paths", String(index)]);
  }, []);

  /*
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
  */

  /*
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

  const [subscriberId] = useState(() => uuidv4());
  const [canvasDiv, setCanvasDiv] = useState<HTMLDivElement | ReactNull>(ReactNull);
  const [chartRenderer, setChartRender] = useState<OffscreenCanvasRenderer | undefined>(undefined);
  const [showReset, setShowReset] = useState(false);

  const [activeTooltip, setActiveTooltip] = useState<{
    x: number;
    y: number;
    data: TimeBasedChartTooltipData[];
  }>();
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
    chartRenderer?.handleConfig(config, globalVariables);
  }, [chartRenderer, config, globalVariables]);

  useEffect(() => {
    if (!chartRenderer) {
      return;
    }
    const unsub = subscribeMessasagePipeline((state) => {
      chartRenderer.handleMessagePipelineState(state);
    });
    return unsub;
  }, [chartRenderer, subscribeMessasagePipeline]);

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
    const renderer = new OffscreenCanvasRenderer(offscreenCanvas);
    setChartRender(renderer);

    const unsub = subscribeMessasagePipeline((state) => {
      renderer.handleMessagePipelineState(state);
    });

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target !== canvasDiv) {
          continue;
        }

        renderer.setSize({
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        });
      }
    });
    resizeObserver.observe(canvasDiv);

    return () => {
      unsub();
      resizeObserver.disconnect();
      renderer.terminate();
      canvasDiv.removeChild(canvas);
    };
  }, [canvasDiv, subscribeMessasagePipeline]);

  const onWheel = useCallback(
    async (event: React.WheelEvent<HTMLElement>) => {
      if (!chartRenderer) {
        return;
      }

      const boundingRect = event.currentTarget.getBoundingClientRect();
      chartRenderer.addInteractionEvent({
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
    [chartRenderer],
  );

  type ElementAtPixelArgs = {
    clientX: number;
    clientY: number;
    canvasX: number;
    canvasY: number;
  };
  const [buildTooltip, setBuildTooltip] = useState<
    ((args: ElementAtPixelArgs) => void) | undefined
  >(undefined);

  const mousePresentRef = useRef(false);

  useEffect(() => {
    const moveHandler = debouncePromise(async (args: ElementAtPixelArgs) => {
      mousePresentRef.current = true;

      const elements = await chartRenderer?.getElementsAtPixel({
        x: args.canvasX,
        y: args.canvasY,
      });

      // eslint does not understand that mousePresentRef can be unset after the await
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (!elements || elements.length === 0 || !mousePresentRef.current) {
        setActiveTooltip(undefined);
        return;
      }

      const tooltipItems: TimeBasedChartTooltipData[] = [];

      for (const element of elements) {
        const value = element.data?.value;
        if (value == undefined) {
          continue;
        }

        tooltipItems.push({
          datasetIndex: element.datasetIndex,
          value,
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
  }, [chartRenderer]);

  // Extract the bounding client rect from currentTarget before calling the debounced function
  // because react re-uses the SyntheticEvent objects.
  const onMouseMove = useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      const boundingRect = event.currentTarget.getBoundingClientRect();
      buildTooltip?.({
        clientX: event.clientX,
        clientY: event.clientY,
        canvasX: event.clientX - boundingRect.left,
        canvasY: event.clientY - boundingRect.top,
      });
    },
    [buildTooltip],
  );

  // Looking up a tooltip is an async operation so the mouse might leave while the component while
  // that is happening and we need to avoid showing a tooltip.
  const onMouseOut = useCallback(() => {
    mousePresentRef.current = false;
    setActiveTooltip(undefined);
  }, []);

  const tooltipContent = useMemo(() => {
    return activeTooltip ? (
      <TimeBasedChartTooltipContent
        content={activeTooltip.data}
        multiDataset={false /* fixme datasetsLength > 1 */}
        colorsByDatasetIndex={{} /* fixme colorsByDatasetIndex */}
        labelsByDatasetIndex={{} /* fixme labelsByDatasetIndex */}
      />
    ) : undefined;
  }, [activeTooltip]);

  useEffect(() => {
    if (!canvasDiv || !chartRenderer) {
      return;
    }

    const hammerManager = new Hammer.Manager(canvasDiv);
    const threshold = 10;
    hammerManager.add(new Hammer.Pan({ threshold }));

    hammerManager.on("panstart", async (event) => {
      const boundingRect = event.target.getBoundingClientRect();
      chartRenderer.addInteractionEvent({
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
      chartRenderer.addInteractionEvent({
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
      chartRenderer.addInteractionEvent({
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
  }, [canvasDiv, chartRenderer]);

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

      const filledParsed = fillInGlobalVariablesInPath(parsed, globalVariables);
      return pathToPayload(filledParsed);
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

    chartRenderer?.setTimeseriesBounds({
      min: globalBounds?.min,
      max: globalBounds?.max,
    });
  }, [chartRenderer, globalBounds, shouldSync, subscriberId]);

  useEffect(() => {
    if (!chartRenderer || !shouldSync) {
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
    chartRenderer.on("timeseriesBounds", onTimeseriesBounds);
    return () => {
      chartRenderer.off("timeseriesBounds", onTimeseriesBounds);
    };
  }, [chartRenderer, setGlobalBounds, shouldSync, subscriberId]);

  const onResetView = useCallback(() => {
    setShowReset(false);
    chartRenderer?.setTimeseriesBounds({ min: undefined, max: undefined });

    if (shouldSync) {
      setGlobalBounds(undefined);
    }
  }, [chartRenderer, setGlobalBounds, shouldSync]);

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
            showPlotValuesInLegend={showPlotValuesInLegend}
            sidebarDimension={sidebarDimension}
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
            style={{ width: "100%", height: "100%", overflow: "hidden" }}
            ref={setCanvasDiv}
            onWheel={onWheel}
            onMouseMove={onMouseMove}
            onMouseOut={onMouseOut}
          />
        </Tooltip>
      </Stack>
    </Stack>
  );
}
