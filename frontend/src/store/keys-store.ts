"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Provider } from "@/lib/providers";

export interface SavedKey {
  id: string;
  label: string;
  provider: Provider;
  key: string;
}

interface KeysState {
  keys: SavedKey[];
  add: (k: Omit<SavedKey, "id">) => void;
  remove: (id: string) => void;
}

/**
 * Named API keys live ONLY in the browser (localStorage) — session/device-local.
 * They are never sent to or stored by the server at rest; the selected key is
 * attached to a chat/run request per call and used transiently.
 */
export const useKeysStore = create<KeysState>()(
  persist(
    (set) => ({
      keys: [],
      add: (k) =>
        set((s) => ({
          keys: [...s.keys, { ...k, id: crypto.randomUUID() }],
        })),
      remove: (id) => set((s) => ({ keys: s.keys.filter((x) => x.id !== id) })),
    }),
    { name: "chunklab-keys" },
  ),
);
