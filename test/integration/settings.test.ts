import { beforeEach, describe, expect, it } from 'vitest';
import { readSettings } from '../../src/ui/settings';
import * as mock from '../helpers/vscodeMock';

describe('readSettings', () => {
  beforeEach(() => mock.reset());

  it('shares the Kiro sign-in unless the user turns it off', () => {
    expect(readSettings().shareKiroLogin).toBe(true);
    mock.state.settings['dev.containers.shareKiroLogin'] = false;
    expect(readSettings().shareKiroLogin).toBe(false);
    mock.state.settings['dev.containers.shareKiroLogin'] = true;
    expect(readSettings().shareKiroLogin).toBe(true);
  });
});
