// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import * as R from "ramda";

import { Immutable } from "@foxglove/studio";
import { messagePathStructures } from "@foxglove/studio-base/components/MessagePathSyntax/messagePathsForDatatype";
import { Topic, MessageEvent } from "@foxglove/studio-base/players/types";
import { RosDatatypes } from "@foxglove/studio-base/types/RosDatatypes";
import { enumValuesByDatatypeAndField } from "@foxglove/studio-base/util/enums";

import { initAccumulated, accumulate, buildPlot } from "./accumulate";
import {
  rebuildClient,
  sendData,
  mapClients,
  noEffects,
  concatEffects,
  mutateClient,
} from "./state";
import { State, StateAndEffects, Client, SideEffects } from "./types";
import { BlockUpdate, ClientUpdate } from "../blocks";
import { Messages } from "../internalTypes";
import { isSingleMessage } from "../params";

export function updateMetadata(
  topics: readonly Topic[],
  datatypes: Immutable<RosDatatypes>,
  state: State,
): State {
  return {
    ...state,
    metadata: {
      topics,
      datatypes,
      enumValues: enumValuesByDatatypeAndField(datatypes),
      structures: messagePathStructures(datatypes),
    },
  };
}

/**
 * Consolidate block data updates for each client and build new plots.
 */
export function applyBlockUpdate(update: BlockUpdate, state: State): StateAndEffects {
  const { metadata, globalVariables } = state;
  const { messages, updates: clientUpdates } = update;

  // We aggregate all of the updates for each client and then apply them as a
  // group. This is because we don't want the `shouldReset` field, which can
  // reset the plot data, to throw away data we aggregated from an update we
  // just applied.
  const updatesByClient = R.toPairs(R.groupBy(({ id }) => id, clientUpdates));

  // This reduce applies updates for each client, one at a time
  return R.reduce(
    (
      stateAndEffects: StateAndEffects,
      [clientId, updates]: [string, ClientUpdate[] | undefined],
    ): StateAndEffects => {
      return concatEffects((newState: State): StateAndEffects => {
        const client = newState.clients.find(({ id }) => id === clientId);
        if (client == undefined || updates == undefined) {
          return noEffects(newState);
        }

        const { params } = client;
        if (params == undefined || isSingleMessage(params)) {
          return noEffects(newState);
        }

        const shouldReset = updates.some(
          ({ update: { shouldReset: updateShouldReset } }) => updateShouldReset,
        );

        // Build a consolidated set of messages by combining all of the updates
        // together
        const clientMessages = R.reduce(
          (a: Messages, clientUpdate: ClientUpdate): Messages => {
            const {
              update: { range, topic },
            } = clientUpdate;

            const [start, end] = range;
            const topicMessages = messages[topic];
            if (topicMessages == undefined) {
              return a;
            }

            return {
              ...a,
              [topic]: topicMessages.slice(start, end).flatMap((v) => v),
            };
          },
          {},
          updates,
        );

        const newBlockData = accumulate(
          metadata,
          globalVariables,
          shouldReset ? initAccumulated() : client.blocks,
          params,
          clientMessages,
        );

        return [
          mutateClient(newState, client.id, {
            ...client,
            blocks: newBlockData,
          }),
          [rebuildClient(client.id)],
        ];
      })(stateAndEffects);
    },
    noEffects(state),
    updatesByClient,
  );
}

/**
 * Distribute new block data to all clients.
 */
export function addBlockData(update: BlockUpdate, state: State): StateAndEffects {
  const { pending } = state;
  const { updates, messages } = update;

  // If we get updates for clients that haven't registered yet, we've got to
  // keep that data around and use it when they register
  const clientIds = state.clients.map(({ id }) => id);
  const unused = updates.filter(({ id }) => !clientIds.includes(id));
  return applyBlockUpdate(update, {
    ...state,
    pending: [...pending, ...(unused.length > 0 ? [{ messages, updates: unused }] : [])],
  });
}

/**
 * Distribute new current data to all clients.
 */
export function addCurrentData(events: readonly MessageEvent[], state: State): StateAndEffects {
  const current: Messages = R.groupBy((v: MessageEvent) => v.topic, events) as Messages;

  return mapClients((client): [Client, SideEffects] => {
    const { metadata, globalVariables } = state;
    const { id, params } = client;
    if (params == undefined) {
      return noEffects(client);
    }

    if (isSingleMessage(params)) {
      const plotData = buildPlot(
        metadata,
        globalVariables,
        params,
        R.map((messages) => messages.slice(-1), current),
      );
      return [client, [sendData(id, plotData)]];
    }

    return [
      {
        ...client,
        current: accumulate(metadata, globalVariables, client.current, params, current),
      },
      [rebuildClient(id)],
    ];
  })(state);
}

/**
 * Clear out the current data for all clients.
 */
export function clearCurrentData(state: State): StateAndEffects {
  const newState = {
    ...state,
    current: {},
  };

  return mapClients((client) => {
    return [
      {
        ...client,
        current: initAccumulated(),
      },
      [rebuildClient(client.id)],
    ];
  })(newState);
}
