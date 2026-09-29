import { create } from "zustand";

interface SelectedTransitionRef {
	trackId: string;
	transitionId: string;
}

interface TransitionsState {
	selectedTransition: SelectedTransitionRef | null;
	setSelectedTransition: (ref: SelectedTransitionRef | null) => void;
}

export const useTransitionsStore = create<TransitionsState>((set) => ({
	selectedTransition: null,
	setSelectedTransition: (ref) => set({ selectedTransition: ref }),
}));
