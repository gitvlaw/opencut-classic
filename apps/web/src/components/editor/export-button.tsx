"use client";

import { useState } from "react";
import { TransitionTopIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Progress } from "@/components/ui/progress";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/utils/ui";
import {
	getExportMimeType,
	getExportFileExtension,
	downloadBuffer,
} from "@/export";
import { Check, Copy, Download, RotateCcw } from "lucide-react";
import {
	EXPORT_FORMAT_VALUES,
	EXPORT_QUALITY_VALUES,
	type ExportFormat,
	type ExportQuality,
} from "@/export";
import {
	Section,
	SectionContent,
	SectionHeader,
	SectionTitle,
} from "@/components/section";
import { useEditor } from "@/editor/use-editor";
import { DEFAULT_EXPORT_OPTIONS } from "@/export/defaults";
import {
	compute1080pTarget,
	shouldOfferUpscale,
	type UpscaleMethod,
} from "@/upscale";
import { isAiUpscaleSupported } from "@/upscale/ai-capability";

function isExportFormat(value: string): value is ExportFormat {
	return EXPORT_FORMAT_VALUES.some((formatValue) => formatValue === value);
}

function isExportQuality(value: string): value is ExportQuality {
	return EXPORT_QUALITY_VALUES.some((qualityValue) => qualityValue === value);
}

export function ExportButton() {
	const [isExportPopoverOpen, setIsExportPopoverOpen] = useState(false);
	const editor = useEditor();
	const activeProject = useEditor((e) => e.project.getActiveOrNull());
	const hasProject = !!activeProject;

	const handlePopoverOpenChange = ({ open }: { open: boolean }) => {
		if (!open) {
			editor.project.cancelExport();
			editor.project.clearExportState();
		}
		setIsExportPopoverOpen(open);
	};

	return (
		<Popover
			open={isExportPopoverOpen}
			onOpenChange={(open) => handlePopoverOpenChange({ open })}
		>
			<PopoverTrigger asChild>
				<button
					type="button"
					className={cn(
						"flex items-center gap-1.5 rounded-md bg-[#38BDF8] px-[0.12rem] py-[0.12rem] text-white",
						hasProject ? "cursor-pointer" : "cursor-not-allowed opacity-50",
					)}
					onClick={hasProject ? () => setIsExportPopoverOpen(true) : undefined}
					disabled={!hasProject}
					onKeyDown={(event) => {
						if (hasProject && (event.key === "Enter" || event.key === " ")) {
							event.preventDefault();
							setIsExportPopoverOpen(true);
						}
					}}
				>
					<div className="relative flex items-center gap-1.5 rounded-[0.6rem] bg-linear-270 from-[#2567EC] to-[#37B6F7] px-4 py-1 shadow-[0_1px_3px_0px_rgba(0,0,0,0.65)]">
						<HugeiconsIcon icon={TransitionTopIcon} className="z-50 size-3.5" />
						<span className="z-50 text-[0.875rem]">Export</span>
						<div className="absolute top-0 left-0 z-10 flex size-full items-center justify-center rounded-[0.6rem] bg-linear-to-t from-white/0 to-white/50">
							<div className="absolute top-[0.08rem] z-50 h-[calc(100%-2px)] w-[calc(100%-2px)] rounded-[0.6rem] bg-linear-270 from-[#2567EC] to-[#37B6F7]"></div>
						</div>
					</div>
				</button>
			</PopoverTrigger>
			{hasProject && <ExportPopover onOpenChange={setIsExportPopoverOpen} />}
		</Popover>
	);
}

function ExportPopover({
	onOpenChange,
}: {
	onOpenChange: (open: boolean) => void;
}) {
	const editor = useEditor();
	const activeProject = useEditor((e) => e.project.getActive());
	const exportState = useEditor((e) => e.project.getExportState());
	const { isExporting, progress, result: exportResult } = exportState;
	const [format, setFormat] = useState<ExportFormat>(
		DEFAULT_EXPORT_OPTIONS.format,
	);
	const [quality, setQuality] = useState<ExportQuality>(
		DEFAULT_EXPORT_OPTIONS.quality,
	);
	const [shouldIncludeAudio, setShouldIncludeAudio] = useState<boolean>(
		DEFAULT_EXPORT_OPTIONS.includeAudio ?? true,
	);
	const [upscaleTo1080, setUpscaleTo1080] = useState(false);
	const [upscaleMethod, setUpscaleMethod] = useState<UpscaleMethod>("shader");
	const [aiEnhance, setAiEnhance] = useState(false);

	const handleExport = async () => {
		if (!activeProject) return;

		const canvasSize = activeProject.settings.canvasSize;
		const canUpscale = shouldOfferUpscale(canvasSize.width, canvasSize.height);
		const target =
			upscaleTo1080 && canUpscale
				? compute1080pTarget(canvasSize.width, canvasSize.height)
				: null;
		// AI enhance also works at canvas resolution (2x internal, then fit
		// back) — denoise + detail even without upscaling.
		const wantEnhance = !!target || (aiEnhance && isAiUpscaleSupported());
		const method: UpscaleMethod = target
			? isAiUpscaleSupported()
				? upscaleMethod
				: "shader"
			: "ai";

		const result = await editor.project.export({
			options: {
				format,
				quality,
				fps: activeProject.settings.fps,
				includeAudio: shouldIncludeAudio,
				...(wantEnhance
					? {
							upscale: {
								width: target?.width ?? canvasSize.width,
								height: target?.height ?? canvasSize.height,
								method,
							},
						}
					: {}),
			},
		});

		if (result.cancelled) {
			editor.project.clearExportState();
			return;
		}

		if (result.success && result.buffer) {
			downloadBuffer({
				buffer: result.buffer,
				filename: `${activeProject.metadata.name}${getExportFileExtension({ format })}`,
				mimeType: getExportMimeType({ format }),
			});

			editor.project.clearExportState();
			onOpenChange(false);
		}
	};

	const handleCancel = () => {
		editor.project.cancelExport();
	};

	return (
		<PopoverContent className="bg-background mr-4 flex w-80 flex-col p-0">
			{exportResult && !exportResult.success ? (
				<ExportError
					error={exportResult.error || "Unknown error occurred"}
					onRetry={handleExport}
				/>
			) : (
				<>
					<div className="flex items-center justify-between p-3 border-b">
						<h3 className="font-medium text-sm">
							{isExporting ? "Exporting project" : "Export project"}
						</h3>
					</div>

					<div className="flex flex-col gap-4">
						{!isExporting && (
							<>
								<div className="flex flex-col">
									<Section
										collapsible
										defaultOpen={false}
										showTopBorder={false}
									>
										<SectionHeader>
											<SectionTitle>Format</SectionTitle>
										</SectionHeader>
										<SectionContent>
											<RadioGroup
												value={format}
												onValueChange={(value) => {
													if (isExportFormat(value)) {
														setFormat(value);
													}
												}}
											>
												<div className="flex items-center space-x-2">
													<RadioGroupItem value="mp4" id="mp4" />
													<Label htmlFor="mp4">
														MP4 (H.264) - Better compatibility
													</Label>
												</div>
												<div className="flex items-center space-x-2">
													<RadioGroupItem value="webm" id="webm" />
													<Label htmlFor="webm">
														WebM (VP9) - Smaller file size
													</Label>
												</div>
											</RadioGroup>
										</SectionContent>
									</Section>

									<Section collapsible defaultOpen={false}>
										<SectionHeader>
											<SectionTitle>Resolution</SectionTitle>
										</SectionHeader>
										<SectionContent>
											<RadioGroup
												value={upscaleTo1080 ? "hd" : "original"}
												onValueChange={(value) => setUpscaleTo1080(value === "hd")}
											>
												<div className="flex items-center space-x-2">
													<RadioGroupItem value="original" id="res-original" />
													<Label htmlFor="res-original">
														Original ({activeProject?.settings.canvasSize.width}×
														{activeProject?.settings.canvasSize.height})
													</Label>
												</div>
												<div className="flex items-center space-x-2">
													<RadioGroupItem
														value="hd"
														id="res-hd"
														disabled={
															!activeProject ||
															!shouldOfferUpscale(
																activeProject.settings.canvasSize.width,
																activeProject.settings.canvasSize.height,
															)
														}
													/>
													<Label htmlFor="res-hd">
														1080p HD — upscale on export
													</Label>
												</div>
											</RadioGroup>
											{activeProject &&
												!shouldOfferUpscale(
													activeProject.settings.canvasSize.width,
													activeProject.settings.canvasSize.height,
												) && (
													<p className="text-muted-foreground mt-1 text-xs">
														Canvas is already 1080p or higher — no upscale
														needed. Use AI enhance below for extra detail.
													</p>
												)}
											{upscaleTo1080 && (
												<div className="mt-2 flex flex-col gap-2 pl-6">
													<RadioGroup
														value={upscaleMethod}
														onValueChange={(value) => {
															if (value === "shader" || value === "ai") {
																setUpscaleMethod(value);
															}
														}}
													>
														<div className="flex items-center space-x-2">
															<RadioGroupItem value="shader" id="up-shader" />
															<Label htmlFor="up-shader">
																Fast (Lanczos, realtime)
															</Label>
														</div>
														<div className="flex items-center space-x-2">
															<RadioGroupItem
																value="ai"
																id="up-ai"
																disabled={!isAiUpscaleSupported()}
															/>
															<Label htmlFor="up-ai">
																AI enhance (slower, best detail)
															</Label>
														</div>
													</RadioGroup>
													{!isAiUpscaleSupported() && (
														<p className="text-muted-foreground text-xs">
															AI enhance needs a WebGPU browser (Chrome/Edge 113+).
														</p>
													)}
													{isAiUpscaleSupported() && upscaleMethod === "ai" && (
														<p className="text-muted-foreground text-xs">
															Downloads a ~5MB model once, then enhances each frame
															while exporting.
														</p>
													)}
												</div>
											)}
											<div className="mt-2 flex items-center space-x-2">
												<Checkbox
													id="ai-enhance"
													checked={aiEnhance}
													disabled={!isAiUpscaleSupported()}
													onCheckedChange={(checked) => setAiEnhance(!!checked)}
												/>
												<Label htmlFor="ai-enhance">
													AI enhance (detail + denoise, any resolution)
												</Label>
											</div>
											{!isAiUpscaleSupported() && (
												<p className="text-muted-foreground text-xs">
													AI enhance needs a WebGPU browser (Chrome/Edge 113+).
												</p>
											)}
										</SectionContent>
									</Section>

									<Section collapsible defaultOpen={false}>
										<SectionHeader>
											<SectionTitle>Quality</SectionTitle>
										</SectionHeader>
										<SectionContent>
											<RadioGroup
												value={quality}
												onValueChange={(value) => {
													if (isExportQuality(value)) {
														setQuality(value);
													}
												}}
											>
												<div className="flex items-center space-x-2">
													<RadioGroupItem value="low" id="low" />
													<Label htmlFor="low">Low - Smallest file size</Label>
												</div>
												<div className="flex items-center space-x-2">
													<RadioGroupItem value="medium" id="medium" />
													<Label htmlFor="medium">Medium - Balanced</Label>
												</div>
												<div className="flex items-center space-x-2">
													<RadioGroupItem value="high" id="high" />
													<Label htmlFor="high">High - Recommended</Label>
												</div>
												<div className="flex items-center space-x-2">
													<RadioGroupItem value="very_high" id="very_high" />
													<Label htmlFor="very_high">
														Very high - Large file size
													</Label>
												</div>
												<div className="flex items-center space-x-2">
													<RadioGroupItem value="ultra" id="ultra" />
													<Label htmlFor="ultra">
														Ultra - Best graded-color fidelity
													</Label>
												</div>
											</RadioGroup>
										</SectionContent>
									</Section>

									<Section collapsible defaultOpen={false}>
										<SectionHeader>
											<SectionTitle>Audio</SectionTitle>
										</SectionHeader>
										<SectionContent>
											<div className="flex items-center space-x-2">
												<Checkbox
													id="include-audio"
													checked={shouldIncludeAudio}
													onCheckedChange={(checked) =>
														setShouldIncludeAudio(!!checked)
													}
												/>
												<Label htmlFor="include-audio">
													Include audio in export
												</Label>
											</div>
										</SectionContent>
									</Section>
								</div>

								<div className="p-3 pt-0">
									<Button onClick={handleExport} className="w-full gap-2">
										<Download className="size-4" />
										Export
									</Button>
								</div>
							</>
						)}

						{isExporting && (
							<div className="space-y-4 p-3">
								<div className="flex flex-col gap-2">
									<div className="flex items-center justify-between text-center">
										<p className="text-muted-foreground text-sm">
											{Math.round(progress * 100)}%
										</p>
										<p className="text-muted-foreground text-sm">100%</p>
									</div>
									<Progress value={progress * 100} className="w-full" />
								</div>

								<Button
									variant="outline"
									className="w-full rounded-md"
									onClick={handleCancel}
								>
									Cancel
								</Button>
							</div>
						)}
					</div>
				</>
			)}
		</PopoverContent>
	);
}

function ExportError({
	error,
	onRetry,
}: {
	error: string;
	onRetry: () => void;
}) {
	const [copied, setCopied] = useState(false);

	const handleCopy = async () => {
		await navigator.clipboard.writeText(error);
		setCopied(true);
		setTimeout(() => setCopied(false), 1000);
	};

	return (
		<div className="space-y-4 p-3">
			<div className="flex flex-col gap-1.5">
				<p className="text-destructive text-sm font-medium">Export failed</p>
				<p className="text-muted-foreground text-xs">{error}</p>
			</div>

			<div className="flex gap-2">
				<Button
					variant="outline"
					size="sm"
					className="h-8 flex-1 text-xs"
					onClick={handleCopy}
				>
					{copied ? <Check className="text-constructive" /> : <Copy />}
					Copy
				</Button>
				<Button
					variant="outline"
					size="sm"
					className="h-8 flex-1 text-xs"
					onClick={onRetry}
				>
					<RotateCcw />
					Retry
				</Button>
			</div>
		</div>
	);
}
