// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import * as R from "ramda";

import parseRosPath from "@foxglove/studio-base/components/MessagePathSyntax/parseRosPath";
import { fillInGlobalVariablesInPath } from "@foxglove/studio-base/components/MessagePathSyntax/useCachedGetMessagePathDataItems";
import { PlotViewport } from "@foxglove/studio-base/components/TimeBasedChart/types";
import { GlobalVariables } from "@foxglove/studio-base/hooks/useGlobalVariables";

import { initAccumulated, accumulate } from "./accumulate";
import { evictCache } from "./messages";
import {
  findClient,
  noEffects,
  mutateClient,
  mapClients,
  rebuildClient,
  keepEffects,
  initClient,
} from "./state";
import { StateAndEffects, SideEffects, State, Client } from "./types";
import { PlotParams } from "../internalTypes";
import { getParamPaths } from "../params";
import {
  reducePlotData,
  PlotData,
  applyDerivativeToPlotData,
  sortPlotDataByHeaderStamp,
} from "../plotData";

export function refreshClient(client: Client, state: State): [Client, SideEffects] {
  const { blocks, current } = state;
  const { id, params } = client;
  return noEffects(client);

  //const paths = getParamPaths(params);
  //const initialState = initAccumulated(client.paths);
  //return [
    //{
      //...client,
      //paths,
      //blocks: accumulate(initialState, params, blocks),
      //current: accumulate(initialState, params, current),
    //},
    //[rebuildClient(id)],
  //];
}

export function updateVariables(variables: GlobalVariables, state: State): StateAndEffects {
  const newState = {
    ...state,
    globalVariables: variables,
  };

  return mapClients((client) => {
    const { params } = client;
    if (params == undefined) {
      return noEffects(client);
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
      return noEffects(client);
    }

    return refreshClient(client, newState);
  })(newState);
}

export function updateParams(id: string, params: PlotParams, state: State): StateAndEffects {
  return R.pipe(
    mapClients((client) => {
      const { id: clientId } = client;
      if (clientId !== id) {
        return noEffects(client);
      }

      return refreshClient(
        {
          ...client,
          params,
          paths: getParamPaths(params),
        },
        state,
      );
    }),
    keepEffects(evictCache),
  )(state);
}

export function updateView(id: string, view: PlotViewport, state: State): StateAndEffects {
  const client = findClient(state, id);
  if (client == undefined) {
    return noEffects(state);
  }
  return [mutateClient(state, id, { ...client, view }), [rebuildClient(id)]];
}

export function register(
  id: string,
  params: PlotParams | undefined,
  state: State,
): StateAndEffects {
  const { clients } = state;
  const newState = {
    ...state,
    clients: [...clients, initClient(id, params)],
  };

  if (params == undefined) {
    return [newState, []];
  }

  return updateParams(id, params, newState);
}

export function unregister(id: string, state: State): State {
  return evictCache({
    ...state,
    clients: R.filter(({ id: clientId }: Client) => clientId !== id, state.clients),
  });
}

export const MESSAGE_CULL_THRESHOLD = 15_000;

export function compressClients(state: State): StateAndEffects {
  const { isLive, current } = state;
  if (!isLive) {
    return noEffects(state);
  }

  return mapClients(refreshClient)({
    ...state,
    current: R.map(
      (messages) =>
        messages.length > MESSAGE_CULL_THRESHOLD
          ? messages.slice(messages.length - MESSAGE_CULL_THRESHOLD)
          : messages,
      current,
    ),
  });
}

export function getClientData(client: Client): PlotData | undefined {
  const {
    params,
    view,
    blocks: { data: blockData },
    current: { data: currentData },
  } = client;

  if (params == undefined || view == undefined) {
    return undefined;
  }

  const { bounds: blockBounds } = blockData;
  const { bounds: currentBounds } = currentData;

  let datasets: PlotData[] = [];
  if (blockBounds.x.min <= currentBounds.x.min && blockBounds.x.max > currentBounds.x.max) {
    // ignore current data if block data covers it already
    datasets = [blockData];
  } else {
    // unbounded plots should also use current data
    datasets = [blockData, currentData];
  }

  return R.pipe(reducePlotData, applyDerivativeToPlotData, sortPlotDataByHeaderStamp)(datasets);
}
