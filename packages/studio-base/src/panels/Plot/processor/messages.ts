// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import * as R from "ramda";

import parseRosPath from "@foxglove/studio-base/components/MessagePathSyntax/parseRosPath";

import { fillInGlobalVariablesInPath } from "@foxglove/studio-base/components/MessagePathSyntax/useCachedGetMessagePathDataItems";
import { GlobalVariables } from "@foxglove/studio-base/hooks/useGlobalVariables";
import { PlotParams, Messages, MetadataEnums, PlotDataItem, BasePlotPath } from "../internalTypes";
import { PlotData, EmptyPlotData, appendPlotData, buildPlotData, resolvePath } from "../plotData";
import { State, Client } from "./state";

type Cursors = Record<string, number>;
export type Accumulated = {
  cursors: Cursors;
  data: PlotData;
};

function getPathData(
  metadata: MetadataEnums,
  globalVariables: GlobalVariables,
  messages: Messages,
  path: BasePlotPath,
): PlotDataItem[] | undefined {
  const parsed = parseRosPath(path.value);
  if (parsed == undefined) {
    return [];
  }

  return resolvePath(
    metadata,
    messages[parsed.topicName] ?? [],
    fillInGlobalVariablesInPath(parsed, globalVariables),
  );
}

function buildPlot(
  metadata: MetadataEnums,
  globalVariables: GlobalVariables,
  params: PlotParams,
  messages: Messages,
): PlotData {
  const { paths, invertedTheme, startTime, xAxisPath, xAxisVal } = params;
  return buildPlotData({
    invertedTheme,
    paths: paths.map((path) => [path, getPathData(metadata, globalVariables, messages, path)]),
    startTime,
    xAxisPath,
    xAxisData:
      xAxisPath != undefined
        ? getPathData(metadata, globalVariables, messages, xAxisPath)
        : undefined,
    xAxisVal,
  });
}

function getNewMessages(
  cursors: Cursors,
  messages: Messages,
): [newCursors: Cursors, newMessages: Messages] {
  const newCursors: Cursors = {};
  const newMessages: Messages = {};

  for (const [topic, cursor] of Object.entries(cursors)) {
    newCursors[topic] = messages[topic]?.length ?? cursor;
    newMessages[topic] = messages[topic]?.slice(cursor) ?? [];
  }

  return [newCursors, newMessages];
}

export function accumulate(
  metadata: MetadataEnums,
  globalVariables: GlobalVariables,
  previous: Accumulated,
  params: PlotParams,
  messages: Messages,
): Accumulated {
  const { cursors: oldCursors, data: oldData } = previous;
  const [newCursors, newMessages] = getNewMessages(oldCursors, messages);

  if (R.isEmpty(newMessages)) {
    return previous;
  }

  return {
    cursors: newCursors,
    data: appendPlotData(oldData, buildPlot(metadata, globalVariables, params, newMessages)),
  };
}

export function initAccumulated(topics: readonly string[]): Accumulated {
  const cursors: Cursors = {};
  for (const topic of topics) {
    cursors[topic] = 0;
  }

  return {
    cursors,
    data: EmptyPlotData,
  };
}

export function evictCache(state: State): State {
  const { clients, blocks, current } = state;
  const topics = R.pipe(
    R.chain(({ topics: clientTopics }: Client) => clientTopics),
    R.uniq,
  )(clients);

  return {
    ...state,
    blocks: R.pick(topics, blocks),
    current: R.pick(topics, current),
  };
}
