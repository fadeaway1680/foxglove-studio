// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import * as R from "ramda";

type Instance<T> = [value: T, numClients: number];

/**
 * A Scheme is a function that is used to decide whether to assign a new client
 * to an existing instance or create a new one. Its input is an array of
 * numbers where each entry represents the number of clients using the instance
 * at that index.
 *
 * The output of the Scheme determines whether a new instance is created or a
 * client is assigned to an existing one:
 * * If the Scheme returns a number in the range [0, counts.length), the client
 *   is assigned to that instance.
 * * If the Scheme returns undefined or a number outside of the range [0,
 *   counts.length), we create a new instance.
 *
 * This allows you to describe just about any job distribution scheme
 * imaginable in a simple way.
 */
export type Scheme = (counts: number[]) => number | undefined;

// A Scheme where we create a new instance for every new client.
export const scheme1to1: Scheme = () => undefined;

// A Scheme where each instance can only have `clientsPerInstance` clients.
// Once it fills up, we create a new instance. If an existing instance has an
// empty slot (such as when a client "disconnects"), we use that instead.
export const schemeFillUp =
  (clientsPerInstance: number): Scheme =>
  (counts: number[]) =>
    counts.findIndex((v) => v < clientsPerInstance);

type Multiplexer<T> = () => [instance: T, dispose: () => void];

/**
 * multiplex is a simple, abstract mechanism for multiplexing a particular
 * resource. Given functions to create and destroy an instance and a
 * distribution scheme, `multiplex` gives you back a function that returns an
 * instance and a disposal function.
 *
 * This can be used to distribute N clients out to M instances of a resource.
 * In our case we use it for allocating clients to Web Workers.
 */
export const multiplex = <T>(
  create: () => T,
  destroy: (arg0: T) => void,
  scheme: Scheme,
): Multiplexer<T> => {
  let instances: Instance<T>[] = [];

  /**
   * Create a new instance and initialize it with 0 clients.
   */
  const createInstance = (): T => {
    const instance = create();
    instances = [...instances, [instance, 0]];
    return instance;
  };

  /**
   * Update the number of clients connected to an instance by `delta`.
   */
  const updateClients = (t: T, delta: number) => {
    instances = instances.map(([value, numClients]) =>
      t === value ? [value, numClients + delta] : [value, numClients],
    );
  };

  /**
   * Add a new client to `t`.
   */
  const addClient = (t: T) => {
    updateClients(t, 1);
  };

  /**
   * Remove a client from `t`, destroying the instance if there are no more
   * clients using the instance.
   */
  const removeClient = (t: T) => {
    updateClients(t, -1);
    const [unused, rest] = R.partition(([, numClients]) => numClients === 0, instances);

    for (const [instance] of unused) {
      destroy(instance);
    }

    instances = rest;
  };

  // When this function is called, it will decide whether to use an existing
  // instance or create a new one and return it along with a disposal function.
  return (): [instance: T, dispose: () => void] => {
    const choice = instances[scheme(instances.map(([, numClients]) => numClients)) ?? -1];
    const instance = choice != undefined ? choice[0] : createInstance();

    addClient(instance);
    const dispose = () => {
      removeClient(instance);
    };
    return [instance, dispose];
  };
};
