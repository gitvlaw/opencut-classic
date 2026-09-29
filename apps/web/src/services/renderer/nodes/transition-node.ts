import { BaseNode } from "./base-node";
import type { VideoNode } from "./video-node";
import type { ImageNode } from "./image-node";
import type { ResolvedVisualSourceNodeState } from "./visual-node";
import type { TrackTransition } from "@/timeline";

export type TransitionParticipantNode = VideoNode | ImageNode;

export interface TransitionNodeParams {
	transition: TrackTransition;
	nodeA: TransitionParticipantNode;
	nodeB: TransitionParticipantNode;
	fromElementId: string;
	toElementId: string;
	cutTime: number;
	duration: number;
	startTime: number;
	endTime: number;
}

export interface ResolvedTransitionNodeState {
	progress: number;
	rawProgress: number;
	resolvedA: ResolvedVisualSourceNodeState;
	resolvedB: ResolvedVisualSourceNodeState;
}

export class TransitionNode extends BaseNode<
	TransitionNodeParams,
	ResolvedTransitionNodeState
> {}
