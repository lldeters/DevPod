import { describe, expect, it } from 'vitest';
import { notificationText } from '../../src/core/errors';

// How the IDE finds links in the text of a notification (LINK_REGEX in VS Code's
// src/vs/base/common/linkedText.ts); `command:` links run a command when clicked.
const LINK = /\[([^\]]+)\]\(((?:https?:\/\/|command:|file:)[^)\s]+)(?: (["'])(.+?)(\3))?\)/gi;

describe('notificationText', () => {
  it.each([
    '[Show Log](command:workbench.action.reloadWindow)',
    'exit code 1: [Retry](https://example.com/x) or [here](file:///etc/hosts "title")',
    'Pod [a](command:b?%5B%22x%22%5D) is not running',
  ])('leaves no link in %j', (text) => {
    expect(text.match(LINK)).not.toBeNull();
    expect(notificationText(text).match(LINK)).toBeNull();
  });

  it('keeps any other text as it is', () => {
    const text = 'Could not set up the server (exit code 2).\n[error] curl: (6) host not found';
    expect(notificationText(text)).toBe(text);
  });
});
