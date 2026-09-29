"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/utils/ui";
import {
	importCubeFile,
	isLutGpuSupported,
	listLuts,
	removeLut,
	type LutEntry,
} from "@/lut/lut-registry";

export function LutPicker({
	lutKey,
	onPick,
}: {
	lutKey: string;
	onPick: (entry: LutEntry | null) => void;
}) {
	const [luts, setLuts] = useState<LutEntry[]>(() => listLuts());
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const fileRef = useRef<HTMLInputElement>(null);

	const refresh = () => setLuts(listLuts());

	const handleFiles = async (files: FileList | null) => {
		const file = files?.[0];
		if (!file) return;
		setBusy(true);
		setError(null);
		try {
			const entry = await importCubeFile(file);
			refresh();
			onPick(entry);
		} catch (e) {
			setError(e instanceof Error ? e.message : "Failed to import .cube file.");
		} finally {
			setBusy(false);
			if (fileRef.current) fileRef.current.value = "";
		}
	};

	return (
		<div className="flex flex-col gap-2 px-4">
			<div className="flex items-center gap-2">
				<Button variant="outline" size="sm" disabled={busy} onClick={() => fileRef.current?.click()}>
					{busy ? "Importing…" : "Import .cube…"}
				</Button>
				<input
					ref={fileRef}
					type="file"
					accept=".cube"
					className="hidden"
					onChange={(e) => void handleFiles(e.target.files)}
				/>
				<span className="text-xs text-muted-foreground">
					{isLutGpuSupported() ? "GPU accelerated" : "CPU preview — publish wasm 0.2.11 for GPU + export"}
				</span>
			</div>
			{error && <p className="text-xs text-destructive">{error}</p>}
			{luts.length === 0 ? (
				<p className="text-xs text-muted-foreground">No LUTs imported yet.</p>
			) : (
				<ul className="flex flex-col gap-1">
					<li>
						<button
							type="button"
							onClick={() => onPick(null)}
							className={cn(
								"flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-sm hover:bg-accent",
								lutKey === "none" && "bg-accent",
							)}
						>
							<span>None</span>
						</button>
					</li>
					{luts.map((lut) => (
						<li key={lut.key}>
							<div
								className={cn(
									"flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-sm hover:bg-accent",
									lutKey === lut.key && "bg-accent",
								)}
							>
								<button type="button" className="flex-1 text-left" onClick={() => onPick(lut)}>
									<span>{lut.name}</span>
									<span className="ml-2 text-xs text-muted-foreground">({lut.size}³)</span>
								</button>
								<Button
									variant="ghost"
									size="sm"
									className="h-6 px-2 text-xs"
									onClick={() => {
										const wasActive = lutKey === lut.key;
										removeLut(lut.key);
										refresh();
										if (wasActive) onPick(null);
									}}
								>
									Remove
								</Button>
							</div>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
