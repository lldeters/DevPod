// Copyright 2026 The Dev Containers for Kiro authors
// SPDX-License-Identifier: Apache-2.0

import * as path from 'node:path';
import { hasUnsafeCharacters, isNetworkPath } from '../authority';
import { DevContainerError } from '../errors';
import { WSL_KUBECONFIG_SEPARATOR, isValidWslDistro, kubeconfigFiles, wslPathOf } from './launcher';
import type { WslSelection } from './launcher';

/** Remote authority prefix for Kubernetes pods: `k8s-pod+<hex>`. */
export const POD_AUTHORITY_PREFIX = 'k8s-pod';

/** One container of one pod, in one cluster context. */
export interface PodRef {
  /** kubeconfig context; the current one if absent. Fixed at attach time. */
  readonly context?: string;
  readonly namespace: string;
  readonly pod: string;
  readonly container: string;
  /**
   * Absolute path of a kubeconfig file; kubectl's own lookup (KUBECONFIG) applies if absent. In
   * WSL it may also start with `~/` (the Linux home directory).
   */
  readonly kubeconfig?: string;
  /** kubectl runs in WSL (Windows only). Fixed at attach time, like the kubeconfig. */
  readonly wsl?: WslSelection;
}

// Kubernetes object names are DNS-1123 subdomains; container names are DNS-1123 labels.
const DNS_NAME = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/;
// Context names are free-form (EKS contexts look like arn:aws:eks:eu-west-1:123:cluster/name).
const CONTEXT_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/@=+-]*$/;

function fail(what: string): never {
  throw new DevContainerError('AUTHORITY_INVALID', `The Kubernetes target has an invalid ${what}.`);
}

/**
 * Checks every field. These values end up as kubectl arguments, so none may start with a dash or
 * contain anything but the characters Kubernetes itself allows.
 */
export function assertPodRef(ref: PodRef, delimiter: string = path.delimiter): void {
  if (ref.namespace.length > 63 || !DNS_NAME.test(ref.namespace)) fail('namespace');
  if (ref.pod.length > 253 || !DNS_NAME.test(ref.pod)) fail('pod name');
  if (ref.container.length > 63 || !DNS_NAME.test(ref.container)) fail('container name');
  if (ref.context !== undefined && (ref.context.length > 253 || !CONTEXT_NAME.test(ref.context))) {
    fail('context');
  }
  if (ref.wsl?.distro !== undefined && !isValidWslDistro(ref.wsl.distro)) {
    fail('WSL distribution');
  }
  if (ref.kubeconfig !== undefined) {
    // Several files are each checked, split as kubectl will split them: by ";" in WSL, else like
    // KUBECONFIG on this machine.
    const files = kubeconfigFiles(ref.kubeconfig, ref.wsl ? WSL_KUBECONFIG_SEPARATOR : delimiter);
    if (
      files.length === 0 ||
      hasUnsafeCharacters(ref.kubeconfig) ||
      !files.every((file) => isKubeconfigPath(file, ref.wsl))
    ) {
      fail('kubeconfig path');
    }
    // A kubeconfig decides which server kubectl talks to and can run commands (exec credential
    // plugins), and reading one from a share already contacts that host.
    if (files.some(isNetworkPath)) {
      fail('kubeconfig path (network shares are not supported)');
    }
  }
}

/**
 * An absolute path. In WSL also `~/...`, and only a Linux path, a Windows path with a drive letter
 * or a Windows path into a distribution (`\\wsl.localhost\...`): the forms kubectl in WSL can use.
 */
function isKubeconfigPath(file: string, wsl: WslSelection | undefined): boolean {
  if (wsl) {
    return (
      path.posix.isAbsolute(file) ||
      file.startsWith('~/') ||
      /^[A-Za-z]:[\\/]/.test(file) ||
      wslPathOf(file) !== undefined
    );
  }
  return path.posix.isAbsolute(file) || path.win32.isAbsolute(file);
}

export function isPodAuthority(authority: string | undefined): authority is string {
  return authority?.startsWith(`${POD_AUTHORITY_PREFIX}+`) ?? false;
}

interface Payload extends PodRef {
  v: 1;
}

export function encodePodAuthority(ref: PodRef): string {
  assertPodRef(ref);
  const payload: Payload = {
    v: 1,
    namespace: ref.namespace,
    pod: ref.pod,
    container: ref.container,
    ...(ref.context === undefined ? {} : { context: ref.context }),
    ...(ref.kubeconfig === undefined ? {} : { kubeconfig: ref.kubeconfig }),
    ...(ref.wsl === undefined
      ? {}
      : { wsl: ref.wsl.distro === undefined ? {} : { distro: ref.wsl.distro } }),
  };
  return `${POD_AUTHORITY_PREFIX}+${Buffer.from(JSON.stringify(payload), 'utf8').toString('hex')}`;
}

function text(record: Record<string, unknown>, key: string, required: boolean): string | undefined {
  const value = record[key];
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string') fail(key);
  return value;
}

/** Decodes and validates an authority; it may come from a link, so nothing is trusted. */
export function decodePodAuthority(authority: string): PodRef {
  if (!isPodAuthority(authority)) {
    throw new DevContainerError('AUTHORITY_INVALID', 'Not a Kubernetes pod authority.');
  }
  const hex = authority.slice(POD_AUTHORITY_PREFIX.length + 1);
  if (hex === '' || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) {
    throw new DevContainerError('AUTHORITY_INVALID', 'The remote authority is not valid hex.');
  }
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(hex, 'hex').toString('utf8'));
  } catch (error) {
    throw new DevContainerError('AUTHORITY_INVALID', 'The remote authority is not valid JSON.', {
      cause: error,
    });
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new DevContainerError('AUTHORITY_INVALID', 'The remote authority payload is invalid.');
  }
  const record = payload as Record<string, unknown>;
  if (record['v'] !== 1) {
    throw new DevContainerError('AUTHORITY_INVALID', 'Unsupported remote authority version.');
  }
  const context = text(record, 'context', false);
  const kubeconfig = text(record, 'kubeconfig', false);
  const wsl = wslSelection(record['wsl']);
  const ref: PodRef = {
    namespace: text(record, 'namespace', true) as string,
    pod: text(record, 'pod', true) as string,
    container: text(record, 'container', true) as string,
    ...(context === undefined ? {} : { context }),
    ...(kubeconfig === undefined ? {} : { kubeconfig }),
    ...(wsl === undefined ? {} : { wsl }),
  };
  assertPodRef(ref);
  return ref;
}

function wslSelection(value: unknown): WslSelection | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('WSL selection');
  const distro = text(value as Record<string, unknown>, 'distro', false);
  return distro === undefined ? {} : { distro };
}
