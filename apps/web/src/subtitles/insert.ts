import type { EditorCore } from "@/core";
import { InsertSubtitlesCommand } from "@/commands";
import type { SubtitleCue } from "./types";

export function insertCaptionChunksAsTextTrack({
	editor,
	captions,
	sourceClipId,
}: {
	editor: EditorCore;
	captions: SubtitleCue[];
	sourceClipId?: string;
}): string | null {
	if (captions.length === 0) {
		return null;
	}

	const command = new InsertSubtitlesCommand({
		captions,
		sourceClipId,
	});

	editor.command.execute({ command });

	return command.getTrackId();
}
