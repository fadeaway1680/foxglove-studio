// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { Immutable } from "@foxglove/studio";
import { MessageEvent } from "@foxglove/studio";
import { MessageBlock } from "@foxglove/studio-base/players/types";

/**
 * BlockCursor tracks the last seen block messages for a given topic and can produce the next
 * block that has not yet been processed.
 *
 * When block topic data changes, it re-starts _next_.
 */
export class BlockTopicCursor {
  #firstBlockRef: Immutable<MessageEvent[]> | undefined;

  #nextBlockIdx = 0;
  #topic: string;

  public constructor(topic: string) {
    this.#topic = topic;
  }

  /**
   * Return true if reading _next_ will reset the cursor
   */
  public nextWillReset(blocks: Immutable<(MessageBlock | undefined)[]>): boolean {
    const blockTopic = blocks[0]?.messagesByTopic[this.#topic];
    return blockTopic !== this.#firstBlockRef;
  }

  /**
   * Given an array of blocks, return the next set of messages.
   *
   * When the underlying topic data changes, the cursor is reset.
   */
  public next(
    blocks: Immutable<(MessageBlock | undefined)[]>,
  ): Immutable<MessageEvent[]> | undefined {
    const blockTopic = blocks[0]?.messagesByTopic[this.#topic];
    if (blockTopic !== this.#firstBlockRef) {
      this.#nextBlockIdx = 0;
      this.#firstBlockRef = blockTopic;
    }

    const idx = this.#nextBlockIdx;
    if (idx >= blocks.length) {
      return undefined;
    }

    // if the block is not yet loaded we do not increment next
    const block = blocks[idx];
    if (!block) {
      return;
    }

    ++this.#nextBlockIdx;
    return block.messagesByTopic[this.#topic];
  }
}
