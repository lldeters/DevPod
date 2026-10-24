// Copyright 2026 The Dev Containers for Kiro authors
// SPDX-License-Identifier: Apache-2.0

import { DevContainerError } from '../errors';
import type { PodInfo } from './kubectl';

/**
 * Throws, in words that say what to do, unless `container` of the pod exists and is running.
 * Used before attaching and again when a window reconnects, since a pod can restart in between.
 */
export function checkContainerRunning(pod: PodInfo, container: string): void {
  if (pod.phase !== 'Running') {
    throw new DevContainerError(
      'ENGINE_UNAVAILABLE',
      `Pod ${pod.name} is not running (status: ${pod.phase}). Wait until it is Running and try again.`,
    );
  }
  const found = pod.containers.find((entry) => entry.name === container);
  if (!found) {
    const names = pod.containers.map((entry) => entry.name).join(', ') || 'none';
    throw new DevContainerError(
      'ENGINE_UNAVAILABLE',
      `Pod ${pod.name} has no container "${container}". Containers: ${names}.`,
    );
  }
  if (!found.running) {
    throw new DevContainerError(
      'ENGINE_UNAVAILABLE',
      `Container "${container}" of pod ${pod.name} is not running yet.`,
    );
  }
}
