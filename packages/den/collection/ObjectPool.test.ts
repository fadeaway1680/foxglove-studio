// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { ObjectPool } from "./ObjectPool";

describe("ObjectPool", () => {
  it("creates a new object when the pool is empty", () => {
    const objectPool = new ObjectPool(() => ({ a: 1 }));
    const obj = objectPool.acquire();
    expect(obj).toEqual({ a: 1 });
  });
  it("uses released objects if it has some", () => {
    const objectPool = new ObjectPool(() => ({ a: 1 }));
    const obj1 = { a: 1 };
    objectPool.release(obj1);
    const acq = objectPool.acquire();
    // should have same object reference
    expect(acq === obj1).toBe(true);
  });
  it("does not release past the maximum capacity", () => {
    const list = [{ a: 1 }, { a: 1 }];
    const objectPool = new ObjectPool(() => ({ a: 1 }), 1);
    list.forEach((obj) => {
      objectPool.release(obj);
    });
    // first object should be released, second should be dropped
    expect(objectPool.acquire() === list[0]).toBe(true);
    expect(objectPool.acquire() === list[1]).toBe(false);
  });
});
