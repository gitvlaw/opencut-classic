"use client";

import { useState, useRef } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { toast } from "sonner";
import { useEditor } from "@/editor/use-editor";
import { vocalSeparationService } from "@/services/vocal-separation/service";
import type {
	SeparationMode,
	VocalSeparationProgress,
} from "@/services/vocal-separation/types";
import type { TimelineElement } from "@/timeline/types";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	MusicNote01Icon,
	VolumeHighIcon,
	SparklesIcon,
	Cancel01Icon,
} from "@hugeicons/core-free-icons";
import { cn } from "@/utils/ui";

export interface VocalSeparationDialogProps {
	isOpen: boolean;
	onOpenChange: (open: boolean) => void;
	trackId: string;
	element: TimelineElement;
}

export function VocalSeparationDialog({
	isOpen,
	onOpenChange,
	trackId,
	element,
}: VocalSeparationDialogProps) {
	const editor = useEditor();
	const [mode, setMode] = useState<SeparationMode>("both");
	const [isProcessing, setIsProcessing] = useState(false);
	const [progress, setProgress] = useState<VocalSeparationProgress>({
		phase: "init",
		progress: 0,
		message: "",
	});

	const abortControllerRef = useRef<AbortController | null>(null);

	const handleOpenChange = (open: boolean) => {
		if (isProcessing) {
			return; // Don't allow closing while processing without explicitly clicking Cancel
		}
		onOpenChange(open);
	};

	const handleCancel = () => {
		if (isProcessing) {
			vocalSeparationService.cancel();
			abortControllerRef.current?.abort();
			setIsProcessing(false);
			toast.info("Đã hủy quá trình tách âm thanh.");
		}
		onOpenChange(false);
	};

	const handleStartSeparation = async () => {
		const activeProject = editor.project.getActiveOrNull();
		if (!activeProject) {
			toast.error("Không tìm thấy dự án hiện tại.");
			return;
		}

		// Find media asset of the source element
		const mediaAsset = editor.media
			.getAssets()
			.find((a) => (element as any).mediaId === a.id);

		if (!mediaAsset) {
			toast.error("Không tìm thấy tệp nguồn của clip.");
			return;
		}

		setIsProcessing(true);
		abortControllerRef.current = new AbortController();

		try {
			// 1. Decode audio source to 44.1kHz stereo
			setProgress({
				phase: "init",
				progress: 5,
				message: "Đang giải mã âm thanh 44.1kHz stereo...",
			});

			const sourceData = mediaAsset.file || mediaAsset.url;
			if (!sourceData) {
				throw new Error("Tệp nguồn không khả dụng");
			}

			const decoded = await vocalSeparationService.decodeAudioSource(
				sourceData,
				setProgress,
			);

			const leftToProcess = decoded.left;
			const rightToProcess = decoded.right;

			// 2. Separate audio stems via Web Worker AI
			const result = await vocalSeparationService.separateAudio({
				leftChannel: leftToProcess,
				rightChannel: rightToProcess,
				sampleRate: 44100,
				options: {
					mode,
					onProgress: setProgress,
					signal: abortControllerRef.current.signal,
				},
			});

			setProgress({
				phase: "encoding",
				progress: 96,
				message: "Đang lưu tệp âm thanh vào dự án...",
			});

			let vocalsMediaAsset = undefined;
			let instMediaAsset = undefined;

			// 3. Save separated stems to project MediaManager (IndexedDB backed)
			if (result.vocalsBlob) {
				const vocalsFile = new File(
					[result.vocalsBlob],
					`${element.name}_Vocals.wav`,
					{ type: "audio/wav" },
				);
				vocalsMediaAsset = await editor.media.addMediaAsset({
					projectId: activeProject.metadata.id,
					asset: {
						name: `${element.name} (Vocals)`,
						type: "audio",
						duration: result.duration,
						hasAudio: true,
						file: vocalsFile,
						url: URL.createObjectURL(vocalsFile),
					},
				});
			}

			if (result.instrumentalBlob) {
				const instFile = new File(
					[result.instrumentalBlob],
					`${element.name}_Instrumental.wav`,
					{ type: "audio/wav" },
				);
				instMediaAsset = await editor.media.addMediaAsset({
					projectId: activeProject.metadata.id,
					asset: {
						name: `${element.name} (Instrumental)`,
						type: "audio",
						duration: result.duration,
						hasAudio: true,
						file: instFile,
						url: URL.createObjectURL(instFile),
					},
				});
			}

			// 4. Place stems onto timeline
			editor.timeline.separateVocals({
				trackId,
				elementId: element.id,
				mode,
				vocalsAsset: vocalsMediaAsset ?? undefined,
				instrumentalAsset: instMediaAsset ?? undefined,
			});

			toast.success("Tách lời và nhạc thành công!");
			setIsProcessing(false);
			onOpenChange(false);
		} catch (error) {
			if (error instanceof DOMException && error.name === "AbortError") {
				// Cancelled by user
				return;
			}
			console.error("Vocal separation failed:", error);
			const msg = error instanceof Error ? error.message : "Đã có lỗi xảy ra";
			toast.error(`Tách lời thất bại: ${msg}`);
			setIsProcessing(false);
			setProgress({
				phase: "error",
				progress: 0,
				message: msg,
			});
		}
	};

	return (
		<Dialog open={isOpen} onOpenChange={handleOpenChange}>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<HugeiconsIcon icon={SparklesIcon} className="text-primary size-5" />
						Tách lời khỏi nhạc (Stem Isolation)
					</DialogTitle>
				</DialogHeader>

				<DialogBody className="flex flex-col gap-4 py-2">
					{/* Target Clip Summary */}
					<div className="bg-muted/40 rounded-lg p-3 text-xs flex flex-col gap-1 border">
						<div className="font-medium text-foreground truncate">
							Clip nguồn: <span className="text-muted-foreground">{element.name}</span>
						</div>
						<div className="text-muted-foreground">
							Thời lượng: {(Number(element.duration) / 1000).toFixed(1)} giây
						</div>
					</div>

					{/* Mode Selector */}
					{!isProcessing && (
						<div className="flex flex-col gap-2">
							<label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
								Chế độ tách
							</label>

							<div className="grid grid-cols-1 gap-2">
								{/* Mode 1: Both */}
								<div
									onClick={() => setMode("both")}
									className={cn(
										"flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-all",
										mode === "both"
											? "border-primary bg-primary/5 ring-1 ring-primary"
											: "border-border hover:bg-accent/40",
									)}
								>
									<HugeiconsIcon icon={SparklesIcon} className="size-5 text-primary mt-0.5" />
									<div className="flex-1">
										<div className="text-sm font-medium">Tách cả 2 (Vocals & Instrumental)</div>
										<div className="text-xs text-muted-foreground">
											Tạo 2 track riêng: 1 track Giọng hát và 1 track Nhạc nền.
										</div>
									</div>
								</div>

								{/* Mode 2: Vocals only */}
								<div
									onClick={() => setMode("vocals_only")}
									className={cn(
										"flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-all",
										mode === "vocals_only"
											? "border-primary bg-primary/5 ring-1 ring-primary"
											: "border-border hover:bg-accent/40",
									)}
								>
									<HugeiconsIcon icon={VolumeHighIcon} className="size-5 text-primary mt-0.5" />
									<div className="flex-1">
										<div className="text-sm font-medium">Chỉ giữ lời (Isolate Vocals)</div>
										<div className="text-xs text-muted-foreground">
											Giữ lại giọng nói/giọng hát, triệt tiêu toàn bộ nhạc nền.
										</div>
									</div>
								</div>

								{/* Mode 3: Instrumental only (Karaoke) */}
								<div
									onClick={() => setMode("instrumental_only")}
									className={cn(
										"flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-all",
										mode === "instrumental_only"
											? "border-primary bg-primary/5 ring-1 ring-primary"
											: "border-border hover:bg-accent/40",
									)}
								>
									<HugeiconsIcon icon={MusicNote01Icon} className="size-5 text-primary mt-0.5" />
									<div className="flex-1">
										<div className="text-sm font-medium">Tách Karaoke (Remove Vocals)</div>
										<div className="text-xs text-muted-foreground">
											Giữ lại beat nhạc, loại bỏ giọng hát để làm nhạc karaoke.
										</div>
									</div>
								</div>
							</div>
						</div>
					)}

					{/* Processing State */}
					{isProcessing && (
						<div className="flex flex-col gap-3 py-4">
							<div className="flex items-center justify-between text-xs">
								<span className="font-medium text-foreground truncate max-w-[80%]">
									{progress.message || "Đang xử lý..."}
								</span>
								<span className="font-semibold text-primary">{progress.progress}%</span>
							</div>

							<Progress value={progress.progress} className="h-2" />

							<div className="text-[11px] text-muted-foreground text-center">
								AI đang chạy trực tiếp trên thiết bị (WebGPU / WASM).
								Không tải dữ liệu lên máy chủ.
							</div>
						</div>
					)}
				</DialogBody>

				<DialogFooter className="gap-2">
					{isProcessing ? (
						<Button variant="outline" onClick={handleCancel} className="gap-1.5 w-full">
							<HugeiconsIcon icon={Cancel01Icon} className="size-4" />
							Hủy bỏ
						</Button>
					) : (
						<>
							<Button variant="outline" onClick={() => onOpenChange(false)}>
								Đóng
							</Button>
							<Button onClick={handleStartSeparation} className="gap-1.5">
								<HugeiconsIcon icon={SparklesIcon} className="size-4" />
								Bắt đầu tách
							</Button>
						</>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
