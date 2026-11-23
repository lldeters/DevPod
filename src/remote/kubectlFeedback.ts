// Copyright 2026 The Dev Containers for Kiro authors
// SPDX-License-Identifier: Apache-2.0

import * as vscode from 'vscode';
import { DevContainerError, notificationText } from '../core/errors';
import type { QueryOptions } from '../core/k8s/kubectl';
import { SignInDetector } from '../core/k8s/signIn';
import type { SignInPrompt } from '../core/k8s/signIn';
import type { Logger } from '../core/logger';

/** After this long, a kubectl query that has not ended is reported as still running. */
export const SLOW_QUERY_MS = 15_000;
/** How long a sign-in page waits for its code, which may come on the next line. */
const PROMPT_DELAY_MS = 300;
const MAX_MESSAGE = 240;

function shorten(text: string): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length > MAX_MESSAGE ? `${single.slice(0, MAX_MESSAGE - 1)}…` : single;
}

/**
 * Makes kubectl queries visible while they run: what kubectl and its credential plugins write to
 * stderr goes to the log and to the progress notification, a sign-in page they ask for is offered
 * with a button, and a query that takes long says so. Queries stop when `signal` is aborted.
 */
export class KubectlFeedback implements vscode.Disposable {
  private readonly detector = new SignInDetector();
  private readonly offered = new Set<string>();
  private pending: { prompt: SignInPrompt; timer: NodeJS.Timeout } | undefined;

  constructor(
    private readonly logger: Logger,
    private readonly report: (message: string) => void,
    readonly signal: AbortSignal,
    private readonly slowAfterMs: number = SLOW_QUERY_MS,
  ) {}

  /** Runs one query (`label` names it in the log) with this feedback. */
  async run<T>(label: string, query: (options: QueryOptions) => Promise<T>): Promise<T> {
    const slow = setTimeout(() => {
      const seconds = Math.round(this.slowAfterMs / 1000);
      this.logger.log(
        'warn',
        `kubectl ${label} is still running after ${seconds} s. It may be waiting for a sign-in ` +
          '(a credential plugin of the kubeconfig) or for the cluster to answer; its messages, if ' +
          'any, are logged here. Cancel the notification to stop it.',
      );
      this.report(
        `kubectl ${label} is still running; it may be waiting for a sign-in or for the cluster. ` +
          'Details: Output → Kiro Dev Containers.',
      );
    }, this.slowAfterMs);
    try {
      return await query({ signal: this.signal, onStderrLine: (line) => this.line(label, line) });
    } finally {
      clearTimeout(slow);
      // A sign-in that is no longer awaited is not offered any more.
      this.dropPending();
    }
  }

  dispose(): void {
    this.dropPending();
  }

  private line(label: string, line: string): void {
    if (line.trim() === '') {
      return;
    }
    this.logger.log('info', `kubectl ${label}: ${line}`);
    this.report(notificationText(shorten(line)));
    const prompt = this.detector.push(line);
    if (prompt !== undefined) {
      this.schedule(prompt);
    }
  }

  private schedule(prompt: SignInPrompt): void {
    this.dropPending();
    const timer = setTimeout(() => {
      this.pending = undefined;
      void this.offer(prompt);
    }, PROMPT_DELAY_MS);
    this.pending = { prompt, timer };
  }

  private dropPending(): void {
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending = undefined;
    }
  }

  private async offer(prompt: SignInPrompt): Promise<void> {
    const key = `${prompt.url} ${prompt.code ?? ''}`;
    if (this.offered.has(key) || this.signal.aborted) {
      return;
    }
    this.offered.add(key);
    this.logger.log(
      'info',
      `kubectl waits for a sign-in at ${prompt.url}${prompt.code ? ` with the code ${prompt.code}` : ''}`,
    );
    const open = 'Open in Browser';
    const copyAndOpen = 'Copy Code and Open';
    const message = prompt.code
      ? `kubectl is waiting for you to sign in: open ${prompt.url} and enter the code ${prompt.code}.`
      : `kubectl is waiting for you to sign in at ${prompt.url}.`;
    const choice = await vscode.window.showInformationMessage(
      notificationText(message),
      ...(prompt.code ? [copyAndOpen, open] : [open]),
    );
    if (choice === copyAndOpen && prompt.code) {
      await vscode.env.clipboard.writeText(prompt.code);
    }
    if (choice === open || choice === copyAndOpen) {
      await vscode.env.openExternal(vscode.Uri.parse(prompt.url));
    }
  }
}

/**
 * Runs `task` under a cancellable progress notification titled `title`, with feedback for its
 * kubectl queries; `report` sets the notification's message. Cancelling aborts `feedback.signal`,
 * which stops the running query; the task then fails with `CANCELLED`.
 */
export function withKubectlProgress<T>(
  title: string,
  logger: Logger,
  task: (feedback: KubectlFeedback, report: (message: string) => void) => Promise<T>,
  slowAfterMs?: number,
): Promise<T> {
  return Promise.resolve(
    vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title, cancellable: true },
      async (progress, token) => {
        const abort = new AbortController();
        const subscription = token.onCancellationRequested(() => abort.abort());
        const report = (message: string): void => progress.report({ message });
        const feedback = new KubectlFeedback(logger, report, abort.signal, slowAfterMs);
        try {
          const result = await task(feedback, report);
          if (abort.signal.aborted) {
            throw new DevContainerError('CANCELLED', `${title}: cancelled.`);
          }
          return result;
        } finally {
          feedback.dispose();
          subscription.dispose();
        }
      },
    ),
  );
}
