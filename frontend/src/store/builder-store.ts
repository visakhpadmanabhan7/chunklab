import { create } from "zustand";
import type { DraftCombination } from "@/lib/types";

interface BuilderState {
  combos: DraftCombination[];
  add: (c: DraftCombination) => boolean; // false if duplicate
  remove: (label: string) => void;
  clear: () => void;
}

export const useBuilderStore = create<BuilderState>((set, get) => ({
  combos: [],
  add: (c) => {
    if (get().combos.some((x) => x.label === c.label)) return false;
    set((s) => ({ combos: [...s.combos, c] }));
    return true;
  },
  remove: (label) => set((s) => ({ combos: s.combos.filter((x) => x.label !== label) })),
  clear: () => set({ combos: [] }),
}));
