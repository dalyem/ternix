import { describe, expect, it } from 'vitest';
import { HOST_OS } from '@ternix/core/items';
import { osLook } from '../src/renderer/src/osLooks.js';

describe('osLook', () => {
  it('has a look for every operating system the protocol names', () => {
    for (const os of HOST_OS) expect(osLook(os)?.title).toBeTruthy();
  });

  it.each(['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'beos', '', 42, null])(
    'has none for %s, so the tile draws the generic glyph',
    (value) => {
      expect(osLook(value)).toBeUndefined();
    },
  );
});
