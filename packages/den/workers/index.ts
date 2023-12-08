// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import * as R from "ramda";

type Instance<T> = [value: T, numClients: number];

type Scheme = (counts: number[]) => number | undefined;

export const scheme1to1: Scheme = () => undefined;

export const multiplex = <T>(create: () => T, destroy: (arg0: T) => void, scheme: Scheme) => {
  let instances: Instance<T>[] = [];

  const createInstance = (): T => {
    const instance = create();
    instances = [...instances, [instance, 0]];
    return instance;
  };

  const updateClients = (t: T, delta: number) => {
    instances = instances.map(([value, numClients]) =>
      t == value ? [value, numClients + delta] : [value, numClients],
    );
  };

  const addClient = (t: T) => {
    updateClients(t, 1);
  };

  const removeClient = (t: T) => {
    updateClients(t, -1);
    const [unused, rest] = R.partition(([, numClients]) => numClients === 0, instances);

    for (const [instance] of unused) {
      destroy(instance);
    }

    instances = rest;
  };

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
