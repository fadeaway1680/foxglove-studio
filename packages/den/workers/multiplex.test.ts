// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { multiplex } from ".";

describe("multiplex", () => {
  it("creates a new instance when scheme returns undefined", () => {
    let count = 0;
    const create = multiplex<number>(
      () => count++,
      () => count--,
      () => undefined,
    );
    const [instance, destroy] = create();
    expect(instance).toEqual(0);
    expect(count).toEqual(1);
    destroy();
    expect(count).toEqual(0);
  });

  it("creates a new instance when scheme returns index", () => {
    let count = 0;
    const create = multiplex<number>(
      () => count++,
      () => {},
      () => 0,
    );
    create();
    const [instance] = create();
    expect(instance).toEqual(0);
    expect(count).toEqual(1);
  });
});
