// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import * as Comlink from "comlink";
import * as R from "ramda";

import { Immutable } from "@foxglove/studio";
import { iterateTyped } from "@foxglove/studio-base/components/Chart/datasets";
import { RosPath } from "@foxglove/studio-base/components/MessagePathSyntax/constants";
import { messagePathStructures } from "@foxglove/studio-base/components/MessagePathSyntax/messagePathsForDatatype";
import parseRosPath from "@foxglove/studio-base/components/MessagePathSyntax/parseRosPath";
import { fillInGlobalVariablesInPath } from "@foxglove/studio-base/components/MessagePathSyntax/useCachedGetMessagePathDataItems";
import { downsample } from "@foxglove/studio-base/components/TimeBasedChart/downsample";
import {
  ProviderState,
  ProviderStateSetter,
  View,
} from "@foxglove/studio-base/components/TimeBasedChart/types";
import { GlobalVariables } from "@foxglove/studio-base/hooks/useGlobalVariables";
import { Topic, MessageEvent } from "@foxglove/studio-base/players/types";
import { RosDatatypes } from "@foxglove/studio-base/types/RosDatatypes";
import { enumValuesByDatatypeAndField } from "@foxglove/studio-base/util/enums";
import { compare as compareTimes, subtract as subtractTimes, fromSec } from "@foxglove/rostime";

import { resolveTypedIndices } from "./datasets";
import {
  PlotParams,
  PlotDataItem,
  BasePlotPath,
  MetadataEnums,
  TypedData,
  Messages,
} from "./internalTypes";
import {
  buildPlotData,
  getPaths,
  resolvePath,
  appendPlotData,
  reducePlotData,
  PlotData,
  StateHandler,
  EmptyPlotData,
  mapDatasets,
  applyDerivativeToPlotData,
  sortPlotDataByHeaderStamp,
} from "./plotData";

type Setter = ProviderStateSetter<TypedData[]>;

type Cursors = Record<string, number>;
type Accumulated = {
  cursors: Cursors;
  data: PlotData;
};

type ParsedPath = {
  parsed: RosPath;
  value: string;
};

type Client = {
  id: string;
  setPanel: StateHandler | undefined;
  setProvided: Setter | undefined;
  addPartial: Setter | undefined;
  params: PlotParams | undefined;
  topics: readonly string[];
  view: View | undefined;
  blocks: Accumulated;
  current: Accumulated;
  queueRebuild: () => void;
};

let clients: Record<string, Client> = {};
let globalVariables: GlobalVariables = {};
let blocks: Messages = {};
let current: Messages = {};
let metadata: MetadataEnums = {
  topics: [],
  datatypes: new Map(),
  enumValues: {},
  structures: {},
};

function initAccumulated(topics: readonly string[]): Accumulated {
  const cursors: Cursors = {};
  for (const topic of topics) {
    cursors[topic] = 0;
  }

  return {
    cursors,
    data: EmptyPlotData,
  };
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

function getParamPaths(params: PlotParams): readonly string[] {
  return getPaths(params.paths, params.xAxisPath);
}

function getParamTopics(params: PlotParams): readonly string[] {
  return R.pipe(
    R.chain((path: string): ParsedPath[] => {
      const parsed = parseRosPath(path);
      if (parsed == undefined) {
        return [];
      }

      return [
        {
          parsed,
          value: path,
        },
      ];
    }),
    R.map((v: ParsedPath) => v.parsed.topicName),
    R.uniq,
  )(getParamPaths(params));
}

function getPathData(messages: Messages, path: BasePlotPath): PlotDataItem[] | undefined {
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

function buildPlot(params: PlotParams, messages: Messages): PlotData {
  const { paths, invertedTheme, startTime, xAxisPath, xAxisVal } = params;
  return buildPlotData({
    invertedTheme,
    paths: R.map((path) => [path, getPathData(messages, path)], paths),
    startTime,
    xAxisPath,
    xAxisData: xAxisPath != undefined ? getPathData(messages, xAxisPath) : undefined,
    xAxisVal,
  });
}

function accumulate(previous: Accumulated, params: PlotParams, messages: Messages): Accumulated {
  const { cursors: oldCursors, data: oldData } = previous;
  const [newCursors, newMessages] = getNewMessages(oldCursors, messages);

  if (R.isEmpty(newMessages)) {
    return previous;
  }

  return {
    cursors: newCursors,
    data: appendPlotData(oldData, buildPlot(params, newMessages)),
  };
}

// Throttle rebuilds to only occur at most every 100ms. This is slightly
// different from the throttled/debounced functions we use elsewhere in our
// codebase in that calls during the cooldown period will schedule at most one
// more invocation rather than simply being ignored or queued.
function makeRebuilder(id: string): () => void {
  let queue = false;
  let cooldown: ReturnType<typeof setTimeout> | undefined;

  const doRebuild = () => {
    rebuild(id);
  };
  const schedule = () => {
    cooldown = setTimeout(() => {
      cooldown = undefined;
      if (queue) {
        queue = false;
        doRebuild();
        schedule();
      }
    }, 100);
  };

  return () => {
    if (cooldown == undefined) {
      doRebuild();
      schedule();
      return;
    }
    queue = true;
  };
}

function mutateClient(id: string, client: Client) {
  clients = { ...clients, [id]: client };
}

function getClientData(client: Client): PlotData | undefined {
  const {
    params,
    view,
    blocks: { data: blockData },
    current: { data: currentData },
  } = client;

  if (params == undefined || view == undefined) {
    return undefined;
  }

  return R.pipe(
    reducePlotData,
    applyDerivativeToPlotData,
    sortPlotDataByHeaderStamp,
  )([blockData, currentData]);
}

function getProvidedData(data: PlotData): ProviderState<TypedData[]> {
  const { bounds } = data;
  const datasets = [];
  for (const dataset of data.datasets.values()) {
    datasets.push(dataset);
  }

  return {
    bounds,
    data: {
      datasets,
    },
  };
}

function rebuild(id: string) {
  const client = clients[id];
  if (client == undefined) {
    return;
  }

  const newData = getClientData(client);
  if (newData == undefined) {
    return;
  }

  const { params, view } = client;
  if (params == undefined || view == undefined) {
    return;
  }

  const downsampled = mapDatasets((dataset) => {
    const indices = downsample(iterateTyped, dataset, view);
    const resolved = resolveTypedIndices(dataset.data, indices);
    if (resolved == undefined) {
      return dataset;
    }

    return {
      ...dataset,
      data: resolved,
    };
  }, newData.datasets);

  const { bounds } = newData;
  const datasets = [];
  for (const dataset of downsampled.values()) {
    datasets.push(dataset);
  }

  client.setProvided?.({
    bounds,
    data: {
      datasets,
    },
  });

  client.setPanel?.({
    ...newData,
    bounds,
    datasets: downsampled,
  });
}

function unregister(id: string): void {
  const { [id]: _, ...rest } = clients;
  clients = rest;
}

function receiveMetadata(topics: readonly Topic[], datatypes: Immutable<RosDatatypes>): void {
  metadata = {
    topics,
    datatypes,
    enumValues: enumValuesByDatatypeAndField(datatypes),
    structures: messagePathStructures(datatypes),
  };
}

function refreshClient(id: string) {
  const client = clients[id];
  if (client == undefined) {
    return;
  }

  const { params } = client;
  if (params == undefined) {
    return;
  }

  const topics = getParamTopics(params);
  const initialState = initAccumulated(topics);
  mutateClient(id, {
    ...client,
    topics,
    blocks: accumulate(initialState, params, blocks),
    current: accumulate(initialState, params, current),
  });
  client.queueRebuild();
}

function receiveVariables(variables: GlobalVariables): void {
  globalVariables = variables;

  for (const client of Object.values(clients)) {
    const { params } = client;
    if (params == undefined) {
      continue;
    }

    // We only want to rebuild clients whose paths actually change when global
    // variables do
    const changedPaths = R.pipe(
      R.chain((path: string) => {
        const original = parseRosPath(path);
        if (original == undefined) {
          return [];
        }

        const filled = fillInGlobalVariablesInPath(original, variables);
        return !R.equals(original.messagePath, filled.messagePath) ? [filled] : [];
      }),
    )(getParamPaths(params));

    if (changedPaths.length === 0) {
      continue;
    }

    refreshClient(client.id);
  }
}

// Check for any message data we no longer need.
function evictCache() {
  const topics = R.pipe(
    R.chain(({ topics: clientTopics }: Client) => clientTopics),
    R.uniq,
  )(R.values(clients));
  blocks = R.pick(topics, blocks);
  current = R.pick(topics, current);
}

function addBlock(block: Messages): void {
  const topics = R.keys(block);
  blocks = R.mergeWith(R.concat, blocks, block);

  for (const client of R.values(clients)) {
    const { params } = client;
    const relevantTopics = R.intersection(topics, client.topics);
    if (params == undefined || relevantTopics.length === 0) {
      continue;
    }

    mutateClient(client.id, {
      ...client,
      blocks: accumulate(client.blocks, params, blocks),
    });
    client.queueRebuild();
  }

  evictCache();
}

function clearCurrent(): void {
  current = {};

  for (const client of R.values(clients)) {
    mutateClient(client.id, {
      ...client,
      current: initAccumulated(client.topics),
    });
    client.queueRebuild();
  }
}

function addCurrent(events: readonly MessageEvent[]): void {
  for (const message of events) {
    const { topic } = message;
    current[topic] ??= [];
    current[topic]?.push(message);
  }

  for (const client of R.values(clients)) {
    const { params, current: previous } = client;
    if (params == undefined) {
      continue;
    }

    const { cursors: oldCursors, data: oldData } = previous;
    const [newCursors, newMessages] = getNewMessages(oldCursors, current);

    if (R.isEmpty(newMessages)) {
      continue;
    }

    const newData = buildPlot(params, newMessages);
    client.addPartial?.(getProvidedData(newData));

    mutateClient(client.id, {
      ...client,
      current: {
        cursors: newCursors,
        data: appendPlotData(oldData, newData),
      },
    });
  }

  evictCache();
}

function updateParams(id: string, params: PlotParams): void {
  const client = clients[id];
  if (client == undefined) {
    return;
  }

  mutateClient(id, {
    ...client,
    params,
    topics: getParamTopics(params),
  });
  refreshClient(id);
  evictCache();
}

function updateView(id: string, view: View): void {
  const client = clients[id];
  if (client == undefined) {
    return;
  }

  mutateClient(id, { ...client, view });
  client.queueRebuild();
}

const CULL_THRESHOLD = fromSec(10);

function compressClients(): void {
  current = R.map((messages) => {
    if (messages.length > 10000) {
      return messages.slice(messages.length - 10000);
    }

    const start = messages.at(0)?.receiveTime;
    const end = messages.at(-1)?.receiveTime;
    if (end == undefined || start == undefined) {
      return messages;
    }

    const cutoff = subtractTimes(end, CULL_THRESHOLD);
    const index = R.findIndex(({ receiveTime }) => compareTimes(receiveTime, cutoff) > 0, messages);
    return messages.slice(index);
  }, current);
  for (const client of R.values(clients)) {
    const { params } = client;
    if (params == undefined) {
      continue;
    }

    const accumulated = accumulate(initAccumulated(client.topics), params, current);
    mutateClient(client.id, {
      ...client,
      current: accumulated,
    });
    client.setProvided?.(getProvidedData(accumulated.data));
  }
}
setInterval(compressClients, 2000);

function register(
  id: string,
  setProvided: Setter,
  setPanel: StateHandler,
  addPartial: Setter,
): void {
  mutateClient(id, {
    id,
    setProvided,
    addPartial,
    setPanel,
    params: undefined,
    topics: [],
    view: undefined,
    blocks: initAccumulated([]),
    current: initAccumulated([]),
    queueRebuild: makeRebuilder(id),
  });
}

function getFullData(id: string): PlotData | undefined {
  const client = clients[id];
  if (client == undefined) {
    return;
  }

  return getClientData(client);
}

export const service = {
  addBlock,
  addCurrent,
  buildPlot,
  clearCurrent,
  getFullData,
  receiveMetadata,
  receiveVariables,
  register,
  unregister,
  updateParams,
  updateView,
};
Comlink.expose(service);
