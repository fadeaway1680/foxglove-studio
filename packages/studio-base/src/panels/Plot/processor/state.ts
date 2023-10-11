// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import * as R from "ramda";

import { initAccumulated } from "./accumulate";
import {
  Client,
  RebuildEffect,
  State,
  SideEffectType,
  DataEffect,
  SideEffects,
  StateAndEffects,
} from "./types";
import { PlotParams } from "../internalTypes";
import { PlotData } from "../plotData";

export function initClient(id: string, params: PlotParams | undefined): Client {
  return {
    id,
    params,
    paths: [],
    view: undefined,
    blocks: initAccumulated(),
    current: initAccumulated(),
  };
}

export const rebuildClient = (id: string): RebuildEffect => ({
  type: SideEffectType.Rebuild,
  clientId: id,
});

export const sendData = (id: string, data: PlotData): DataEffect => ({
  type: SideEffectType.Send,
  clientId: id,
  data,
});

export function initProcessor(): State {
  return {
    isLive: false,
    clients: [],
  };
}

export function noEffects<T>(state: T): [T, SideEffects] {
  return [state, []];
}

// eslint-disable-next-line @foxglove/no-boolean-parameters
export const setLive = (isLive: boolean, state: State): State => ({ ...state, isLive });

export const keepEffects =
  (mutator: (state: State) => State) =>
  ([state, effects]: StateAndEffects): StateAndEffects => {
    return [mutator(state), effects];
  };

export const findClient = (state: State, id: string): Client | undefined =>
  R.find((client) => client.id === id, state.clients);

export const mutateClient = (state: State, id: string, newClient: Client): State => ({
  ...state,
  clients: state.clients.map((client) => (client.id === id ? newClient : client)),
});

export const mapClients =
  (mutator: (client: Client, state: State) => [Client, SideEffects]) =>
  (state: State): StateAndEffects => {
    const { clients } = state;
    const changes = clients.map((client): [Client, SideEffects] => mutator(client, state));
    return [
      {
        ...state,
        clients: changes.map(([v]) => v),
      },
      R.chain(([, v]) => v, changes),
    ];
  };
