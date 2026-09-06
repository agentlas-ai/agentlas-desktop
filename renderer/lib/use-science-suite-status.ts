"use client";

import { useSyncExternalStore } from "react";
import type { ScienceSuiteStatus } from "@shared/product-extension";
import { ipc, ipcEvents } from "./ipc";

let statusSnapshot: ScienceSuiteStatus | null = null;
let statusRequested = false;
let statusRequest: Promise<ScienceSuiteStatus | null> | null = null;
let extensionEventsConnected = false;
const subscribers = new Set<() => void>();

function publish(next: ScienceSuiteStatus | null): void {
  if (statusSnapshot === next) return;
  statusSnapshot = next;
  for (const subscriber of subscribers) subscriber();
}

function loadScienceSuiteStatus(force = false): Promise<ScienceSuiteStatus | null> {
  if (statusRequest) return statusRequest;
  if (statusRequested && !force) return Promise.resolve(statusSnapshot);
  statusRequested = true;
  const read = ipc()?.productExtensions?.scienceSuiteStatus;
  if (!read) {
    publish(null);
    return Promise.resolve(null);
  }
  statusRequest = read()
    .then((status) => {
      publish(status);
      return status;
    })
    .catch(() => {
      publish(null);
      return null;
    })
    .finally(() => {
      statusRequest = null;
    });
  return statusRequest;
}

function connectExtensionEvents(): void {
  if (extensionEventsConnected) return;
  extensionEventsConnected = true;
  ipcEvents()?.onProductExtensionChanged?.(() => {
    void loadScienceSuiteStatus(true);
  });
}

function subscribe(subscriber: () => void): () => void {
  subscribers.add(subscriber);
  connectExtensionEvents();
  void loadScienceSuiteStatus();
  return () => subscribers.delete(subscriber);
}

function getSnapshot(): ScienceSuiteStatus | null {
  return statusSnapshot;
}

export function useScienceSuiteStatus(): ScienceSuiteStatus | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
