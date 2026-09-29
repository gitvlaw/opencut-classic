import type { TransitionDefinition } from "../types";

function drawSource(
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
	source: CanvasImageSource,
	dx: number,
	dy: number,
	dw: number,
	dh: number,
	alpha = 1,
) {
	if (alpha <= 0) return;
	ctx.save();
	ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
	ctx.drawImage(source, dx, dy, dw, dh);
	ctx.restore();
}

function drawScaledCentered(
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
	source: CanvasImageSource,
	width: number,
	height: number,
	scale: number,
	rotationRad = 0,
	alpha = 1,
) {
	if (alpha <= 0) return;
	ctx.save();
	ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
	ctx.translate(width / 2, height / 2);
	if (rotationRad !== 0) {
		ctx.rotate(rotationRad);
	}
	ctx.scale(scale, scale);
	ctx.drawImage(source, -width / 2, -height / 2, width, height);
	ctx.restore();
}

export const TRANSITION_DEFINITIONS: TransitionDefinition[] = [
	// ==========================================
	// 1. FADE & DISSOLVE
	// ==========================================
	{
		type: "cross-dissolve",
		name: "Cross Dissolve",
		category: "fade",
		description: "Mờ chồng mượt mà giữa 2 video",
		defaultDuration: 0.5,
		render: (ctx, srcA, srcB, progress, { width, height }) => {
			drawSource(ctx, srcA, 0, 0, width, height, 1);
			drawSource(ctx, srcB, 0, 0, width, height, progress);
		},
	},
	{
		type: "glow-fade",
		name: "Glow Dissolve",
		category: "fade",
		description: "Hòa tan kết hợp chùm sáng mơ mộng (Exposure Bloom)",
		defaultDuration: 0.6,
		render: (ctx, srcA, srcB, progress, { width, height }) => {
			drawSource(ctx, srcA, 0, 0, width, height, 1);
			drawSource(ctx, srcB, 0, 0, width, height, progress);
			const glow = Math.sin(progress * Math.PI);
			if (glow > 0.05) {
				ctx.save();
				ctx.globalCompositeOperation = "screen";
				ctx.fillStyle = `rgba(255, 235, 180, ${glow * 0.75})`;
				ctx.fillRect(0, 0, width, height);
				const radGrad = ctx.createRadialGradient(
					width / 2,
					height / 2,
					10,
					width / 2,
					height / 2,
					Math.max(width, height) * 0.7,
				);
				radGrad.addColorStop(0, `rgba(255, 255, 255, ${glow * 0.9})`);
				radGrad.addColorStop(1, "rgba(255, 200, 100, 0)");
				ctx.fillStyle = radGrad;
				ctx.fillRect(0, 0, width, height);
				ctx.restore();
			}
		},
	},
	{
		type: "zoom-fade",
		name: "Zoom Fade In",
		category: "fade",
		description: "Phóng to nhẹ kết hợp hòa tan mượt mà",
		defaultDuration: 0.55,
		render: (ctx, srcA, srcB, progress, { width, height }) => {
			const scaleA = 1 + progress * 0.18;
			const scaleB = 1.15 - progress * 0.15;
			drawScaledCentered(ctx, srcA, width, height, scaleA, 0, 1 - progress);
			drawScaledCentered(ctx, srcB, width, height, scaleB, 0, progress);
		},
	},
	{
		type: "zoom-out-fade",
		name: "Zoom Fade Out",
		category: "fade",
		description: "Thu nhỏ nhẹ kết hợp hòa tan mượt mà",
		defaultDuration: 0.55,
		render: (ctx, srcA, srcB, progress, { width, height }) => {
			const scaleA = 1 - progress * 0.15;
			const scaleB = 0.85 + progress * 0.15;
			drawScaledCentered(ctx, srcA, width, height, scaleA, 0, 1 - progress);
			drawScaledCentered(ctx, srcB, width, height, scaleB, 0, progress);
		},
	},
	{
		type: "radial-fade",
		name: "Radial Vignette Fade",
		category: "fade",
		description: "Mờ dần theo viền tròn tối từ ngoài vào trong",
		defaultDuration: 0.6,
		render: (ctx, srcA, srcB, progress, { width, height }) => {
			if (progress < 0.5) {
				const p = progress * 2;
				drawSource(ctx, srcA, 0, 0, width, height, 1);
				const maxRadius = Math.hypot(width / 2, height / 2);
				const radius = maxRadius * (1 - p * 0.75);
				const grad = ctx.createRadialGradient(
					width / 2,
					height / 2,
					Math.max(0, radius * 0.25),
					width / 2,
					height / 2,
					Math.max(1, radius),
				);
				grad.addColorStop(0, "rgba(0,0,0,0)");
				grad.addColorStop(1, `rgba(0,0,0,${Math.min(1, p * 1.3)})`);
				ctx.save();
				ctx.fillStyle = grad;
				ctx.fillRect(0, 0, width, height);
				ctx.restore();
			} else {
				const p = (progress - 0.5) * 2;
				drawSource(ctx, srcB, 0, 0, width, height, 1);
				const maxRadius = Math.hypot(width / 2, height / 2);
				const radius = maxRadius * (p * 0.75 + 0.25);
				const grad = ctx.createRadialGradient(
					width / 2,
					height / 2,
					Math.max(0, radius * 0.25),
					width / 2,
					height / 2,
					Math.max(1, radius),
				);
				grad.addColorStop(0, "rgba(0,0,0,0)");
				grad.addColorStop(1, `rgba(0,0,0,${Math.max(0, (1 - p) * 1.3)})`);
				ctx.save();
				ctx.fillStyle = grad;
				ctx.fillRect(0, 0, width, height);
				ctx.restore();
			}
		},
	},
	{
		type: "dip-black",
		name: "Dip to Black",
		category: "fade",
		description: "Mờ dần về đen rồi mở sáng sang clip tiếp theo",
		defaultDuration: 0.6,
		render: (ctx, srcA, srcB, progress, { width, height }) => {
			ctx.fillStyle = "#000000";
			ctx.fillRect(0, 0, width, height);
			if (progress < 0.5) {
				const alpha = 1 - progress * 2;
				drawSource(ctx, srcA, 0, 0, width, height, alpha);
			} else {
				const alpha = (progress - 0.5) * 2;
				drawSource(ctx, srcB, 0, 0, width, height, alpha);
			}
		},
	},
	{
		type: "dip-white",
		name: "Dip to White (Flash)",
		category: "fade",
		description: "Chớp sáng trắng tại điểm cắt",
		defaultDuration: 0.4,
		render: (ctx, srcA, srcB, progress, { width, height }) => {
			if (progress < 0.5) {
				drawSource(ctx, srcA, 0, 0, width, height, 1);
			} else {
				drawSource(ctx, srcB, 0, 0, width, height, 1);
			}
			const flashAlpha = 1 - Math.abs(progress - 0.5) * 2;
			ctx.save();
			ctx.fillStyle = "#ffffff";
			ctx.globalAlpha = Math.max(0, Math.min(1, flashAlpha * 1.1));
			ctx.fillRect(0, 0, width, height);
			ctx.restore();
		},
	},
	{
		type: "color-fade",
		name: "Dip to Warm Amber",
		category: "fade",
		description: "Mờ qua màu cam ấm phong cách hoàng hôn",
		defaultDuration: 0.6,
		render: (ctx, srcA, srcB, progress, { width, height }) => {
			ctx.fillStyle = "#ea580c";
			ctx.fillRect(0, 0, width, height);
			if (progress < 0.5) {
				const alpha = 1 - progress * 2;
				drawSource(ctx, srcA, 0, 0, width, height, alpha);
			} else {
				const alpha = (progress - 0.5) * 2;
				drawSource(ctx, srcB, 0, 0, width, height, alpha);
			}
		},
	},
	{
		type: "lens-flare-fade",
		name: "Lens Flare Dissolve",
		category: "fade",
		description: "Vệt lóa quang học anamorphic vàng & xanh biển",
		defaultDuration: 0.65,
		render: (ctx, srcA, srcB, progress, { width, height }) => {
			drawSource(ctx, srcA, 0, 0, width, height, 1);
			drawSource(ctx, srcB, 0, 0, width, height, progress);
			const intensity = Math.sin(progress * Math.PI);
			if (intensity > 0.05) {
				ctx.save();
				ctx.globalCompositeOperation = "screen";
				const cy = height * (0.35 + progress * 0.3);
				const flareGrad = ctx.createLinearGradient(0, cy, width, cy);
				flareGrad.addColorStop(0, "rgba(59, 130, 246, 0)");
				flareGrad.addColorStop(0.3, `rgba(96, 165, 250, ${intensity * 0.6})`);
				flareGrad.addColorStop(0.5, `rgba(255, 255, 255, ${intensity * 0.95})`);
				flareGrad.addColorStop(0.7, `rgba(251, 191, 36, ${intensity * 0.6})`);
				flareGrad.addColorStop(1, "rgba(251, 191, 36, 0)");
				ctx.fillStyle = flareGrad;
				ctx.fillRect(0, cy - height * 0.08, width, height * 0.16);

				const burst = ctx.createRadialGradient(
					width * progress,
					cy,
					2,
					width * progress,
					cy,
					height * 0.45,
				);
				burst.addColorStop(0, `rgba(255, 255, 255, ${intensity * 0.9})`);
				burst.addColorStop(0.4, `rgba(147, 197, 253, ${intensity * 0.4})`);
				burst.addColorStop(1, "rgba(0,0,0,0)");
				ctx.fillStyle = burst;
				ctx.fillRect(0, 0, width, height);
				ctx.restore();
			}
		},
	},
	{
		type: "soft-blur-fade",
		name: "Soft Dreamy Fade",
		category: "fade",
		description: "Mờ nhòe dịu nhẹ phong cách hoài niệm",
		defaultDuration: 0.6,
		render: (ctx, srcA, srcB, progress, { width, height }) => {
			const blur = Math.sin(progress * Math.PI) * 16;
			ctx.save();
			if (blur > 0.5 && "filter" in ctx) {
				ctx.filter = `blur(${blur.toFixed(1)}px)`;
			}
			drawSource(ctx, srcA, 0, 0, width, height, 1 - progress);
			drawSource(ctx, srcB, 0, 0, width, height, progress);
			ctx.restore();
			const warmth = Math.sin(progress * Math.PI) * 0.25;
			if (warmth > 0.02) {
				ctx.save();
				ctx.globalCompositeOperation = "screen";
				ctx.fillStyle = `rgba(255, 240, 220, ${warmth})`;
				ctx.fillRect(0, 0, width, height);
				ctx.restore();
			}
		},
	},
	{
		type: "film-burn",
		name: "Film Burn (Light Leak)",
		category: "fade",
		description: "Vệt sáng ấm phong cách phim nhựa cinematic",
		defaultDuration: 0.7,
		render: (ctx, srcA, srcB, progress, { width, height }) => {
			drawSource(ctx, srcA, 0, 0, width, height, 1);
			drawSource(ctx, srcB, 0, 0, width, height, progress);

			const intensity = Math.sin(progress * Math.PI);
			if (intensity > 0.01) {
				ctx.save();
				ctx.globalCompositeOperation = "screen";
				const grad = ctx.createLinearGradient(
					width * (progress * 1.5 - 0.25),
					0,
					width * (progress * 1.5 + 0.35),
					height,
				);
				grad.addColorStop(0, "rgba(255, 60, 0, 0)");
				grad.addColorStop(0.3, `rgba(255, 120, 20, ${0.85 * intensity})`);
				grad.addColorStop(0.5, `rgba(255, 230, 140, ${0.95 * intensity})`);
				grad.addColorStop(0.7, `rgba(255, 90, 10, ${0.85 * intensity})`);
				grad.addColorStop(1, "rgba(255, 40, 0, 0)");
				ctx.fillStyle = grad;
				ctx.fillRect(0, 0, width, height);
				ctx.restore();
			}
		},
	},

	// ==========================================
	// 2. CAMERA MOTION
	// ==========================================
	{
		type: "whip-pan-right",
		name: "Whip Pan Right",
		category: "camera",
		description: "Lia máy siêu nhanh sang phải kèm motion blur",
		defaultDuration: 0.5,
		render: (ctx, srcA, srcB, progress, { width, height }) => {
			const xA = width * progress;
			const xB = -width * (1 - progress);
			// Render motion blur ghosting during peak velocity (center)
			const blur = Math.sin(progress * Math.PI) * 40;
			if (blur > 5) {
				[-blur, -blur / 2, blur / 2, blur].forEach((offset) => {
					if (progress < 0.5) {
						drawSource(ctx, srcA, xA + offset, 0, width, height, 0.2);
					} else {
						drawSource(ctx, srcB, xB + offset, 0, width, height, 0.2);
					}
				});
			}
			drawSource(ctx, srcA, xA, 0, width, height, 1 - progress);
			drawSource(ctx, srcB, xB, 0, width, height, progress);
		},
	},
	{
		type: "whip-pan-left",
		name: "Whip Pan Left",
		category: "camera",
		description: "Lia máy siêu nhanh sang trái kèm motion blur",
		defaultDuration: 0.5,
		render: (ctx, srcA, srcB, progress, { width, height }) => {
			const xA = -width * progress;
			const xB = width * (1 - progress);
			const blur = Math.sin(progress * Math.PI) * 40;
			if (blur > 5) {
				[-blur, -blur / 2, blur / 2, blur].forEach((offset) => {
					if (progress < 0.5) {
						drawSource(ctx, srcA, xA + offset, 0, width, height, 0.2);
					} else {
						drawSource(ctx, srcB, xB + offset, 0, width, height, 0.2);
					}
				});
			}
			drawSource(ctx, srcA, xA, 0, width, height, 1 - progress);
			drawSource(ctx, srcB, xB, 0, width, height, progress);
		},
	},
	{
		type: "whip-pan-up",
		name: "Whip Pan Up",
		category: "camera",
		description: "Lia máy siêu nhanh lên trên",
		defaultDuration: 0.5,
		render: (ctx, srcA, srcB, progress, { width, height }) => {
			const yA = -height * progress;
			const yB = height * (1 - progress);
			drawSource(ctx, srcA, 0, yA, width, height, 1 - progress);
			drawSource(ctx, srcB, 0, yB, width, height, progress);
		},
	},
	{
		type: "whip-pan-down",
		name: "Whip Pan Down",
		category: "camera",
		description: "Lia máy siêu nhanh xuống dưới",
		defaultDuration: 0.5,
		render: (ctx, srcA, srcB, progress, { width, height }) => {
			const yA = height * progress;
			const yB = -height * (1 - progress);
			drawSource(ctx, srcA, 0, yA, width, height, 1 - progress);
			drawSource(ctx, srcB, 0, yB, width, height, progress);
		},
	},
	{
		type: "zoom-in",
		name: "Zoom In (Punch In)",
		category: "camera",
		description: "Phóng to lao vào camera chuyển cảnh",
		defaultDuration: 0.5,
		render: (ctx, srcA, srcB, progress, { width, height }) => {
			const scaleA = 1.0 + progress * 1.5;
			const scaleB = 0.4 + progress * 0.6;
			drawScaledCentered(ctx, srcA, width, height, scaleA, 0, 1 - progress);
			drawScaledCentered(ctx, srcB, width, height, scaleB, 0, progress);
		},
	},
	{
		type: "zoom-out",
		name: "Zoom Out (Pull Out)",
		category: "camera",
		description: "Thu nhỏ lùi xa mở ra toàn cảnh mới",
		defaultDuration: 0.5,
		render: (ctx, srcA, srcB, progress, { width, height }) => {
			const scaleA = 1.0 - progress * 0.6;
			const scaleB = 1.8 - progress * 0.8;
			drawScaledCentered(ctx, srcA, width, height, scaleA, 0, 1 - progress);
			drawScaledCentered(ctx, srcB, width, height, scaleB, 0, progress);
		},
	},
	{
		type: "spin-cw",
		name: "Spin Clockwise",
		category: "camera",
		description: "Xoay tròn theo chiều kim đồng hồ",
		defaultDuration: 0.6,
		render: (ctx, srcA, srcB, progress, { width, height }) => {
			const angleA = progress * Math.PI;
			const scaleA = 1 - progress * 0.4;
			const angleB = -(1 - progress) * Math.PI;
			const scaleB = 0.6 + progress * 0.4;
			drawScaledCentered(ctx, srcA, width, height, scaleA, angleA, 1 - progress);
			drawScaledCentered(ctx, srcB, width, height, scaleB, angleB, progress);
		},
	},
	{
		type: "spin-ccw",
		name: "Spin Counter-Clockwise",
		category: "camera",
		description: "Xoay tròn ngược chiều kim đồng hồ",
		defaultDuration: 0.6,
		render: (ctx, srcA, srcB, progress, { width, height }) => {
			const angleA = -progress * Math.PI;
			const scaleA = 1 - progress * 0.4;
			const angleB = (1 - progress) * Math.PI;
			const scaleB = 0.6 + progress * 0.4;
			drawScaledCentered(ctx, srcA, width, height, scaleA, angleA, 1 - progress);
			drawScaledCentered(ctx, srcB, width, height, scaleB, angleB, progress);
		},
	},
	{
		type: "camera-shake",
		name: "Camera Shake (Impact)",
		category: "camera",
		description: "Rung giật rung chuyển khung hình mạnh mẽ",
		defaultDuration: 0.4,
		render: (ctx, srcA, srcB, progress, { width, height }) => {
			const intensity = Math.sin(progress * Math.PI);
			const shakeX = Math.sin(progress * 48) * intensity * 26;
			const shakeY = Math.cos(progress * 38) * intensity * 18;
			ctx.save();
			ctx.translate(shakeX, shakeY);
			if (progress < 0.5) {
				drawSource(ctx, srcA, 0, 0, width, height, 1);
			} else {
				drawSource(ctx, srcB, 0, 0, width, height, 1);
			}
			ctx.restore();
		},
	},

	// ==========================================
	// 3. SLIDE & PUSH
	// ==========================================
	{
		type: "slide-left",
		name: "Slide Left",
		category: "slide",
		description: "Clip tiếp theo trượt từ phải sang trái",
		defaultDuration: 0.5,
		render: (ctx, srcA, srcB, progress, { width, height }) => {
			drawSource(ctx, srcA, 0, 0, width, height, 1);
			drawSource(ctx, srcB, width * (1 - progress), 0, width, height, 1);
		},
	},
	{
		type: "slide-right",
		name: "Slide Right",
		category: "slide",
		description: "Clip tiếp theo trượt từ trái sang phải",
		defaultDuration: 0.5,
		render: (ctx, srcA, srcB, progress, { width, height }) => {
			drawSource(ctx, srcA, 0, 0, width, height, 1);
			drawSource(ctx, srcB, -width * (1 - progress), 0, width, height, 1);
		},
	},
	{
		type: "slide-up",
		name: "Slide Up",
		category: "slide",
		description: "Clip tiếp theo trượt từ dưới lên",
		defaultDuration: 0.5,
		render: (ctx, srcA, srcB, progress, { width, height }) => {
			drawSource(ctx, srcA, 0, 0, width, height, 1);
			drawSource(ctx, srcB, 0, height * (1 - progress), width, height, 1);
		},
	},
	{
		type: "slide-down",
		name: "Slide Down",
		category: "slide",
		description: "Clip tiếp theo trượt từ trên xuống",
		defaultDuration: 0.5,
		render: (ctx, srcA, srcB, progress, { width, height }) => {
			drawSource(ctx, srcA, 0, 0, width, height, 1);
			drawSource(ctx, srcB, 0, -height * (1 - progress), width, height, 1);
		},
	},
	{
		type: "push",
		name: "Push (Smooth Push)",
		category: "slide",
		description: "Clip mới đẩy văng clip cũ ra khỏi màn hình",
		defaultDuration: 0.5,
		hasDirection: true,
		render: (ctx, srcA, srcB, progress, { width, height, direction = "left" }) => {
			let xA = 0;
			let yA = 0;
			let xB = 0;
			let yB = 0;
			switch (direction) {
				case "right":
					xA = width * progress;
					xB = -width * (1 - progress);
					break;
				case "up":
					yA = -height * progress;
					yB = height * (1 - progress);
					break;
				case "down":
					yA = height * progress;
					yB = -height * (1 - progress);
					break;
				case "left":
				default:
					xA = -width * progress;
					xB = width * (1 - progress);
					break;
			}
			drawSource(ctx, srcA, xA, yA, width, height, 1);
			drawSource(ctx, srcB, xB, yB, width, height, 1);
		},
	},
	{
		type: "split-doors",
		name: "Split Doors",
		category: "slide",
		description: "Khung hình cũ tách đôi mở sang hai bên",
		defaultDuration: 0.6,
		render: (ctx, srcA, srcB, progress, { width, height }) => {
			drawSource(ctx, srcB, 0, 0, width, height, 1);
			const halfW = width / 2;
			const offset = halfW * progress;
			// Left door
			ctx.save();
			ctx.beginPath();
			ctx.rect(0, 0, halfW - offset, height);
			ctx.clip();
			drawSource(ctx, srcA, -offset, 0, width, height, 1);
			ctx.restore();
			// Right door
			ctx.save();
			ctx.beginPath();
			ctx.rect(halfW + offset, 0, halfW - offset, height);
			ctx.clip();
			drawSource(ctx, srcA, offset, 0, width, height, 1);
			ctx.restore();
		},
	},

	// ==========================================
	// 4. WIPE & MASK
	// ==========================================
	{
		type: "linear-wipe",
		name: "Linear Wipe",
		category: "wipe",
		description: "Vệt ranh giới quét ngang để lộ khung hình mới",
		defaultDuration: 0.5,
		render: (ctx, srcA, srcB, progress, { width, height }) => {
			drawSource(ctx, srcA, 0, 0, width, height, 1);
			const wipeX = width * progress;
			ctx.save();
			ctx.beginPath();
			ctx.rect(0, 0, wipeX, height);
			ctx.clip();
			drawSource(ctx, srcB, 0, 0, width, height, 1);
			ctx.restore();
		},
	},
	{
		type: "clock-wipe",
		name: "Clock Wipe",
		category: "wipe",
		description: "Kim đồng hồ quét 360 độ từ tâm để mở cảnh",
		defaultDuration: 0.7,
		render: (ctx, srcA, srcB, progress, { width, height }) => {
			drawSource(ctx, srcA, 0, 0, width, height, 1);
			const cx = width / 2;
			const cy = height / 2;
			const radius = Math.hypot(width, height);
			const startAngle = -Math.PI / 2;
			const endAngle = startAngle + 2 * Math.PI * progress;
			ctx.save();
			ctx.beginPath();
			ctx.moveTo(cx, cy);
			ctx.arc(cx, cy, radius, startAngle, endAngle);
			ctx.closePath();
			ctx.clip();
			drawSource(ctx, srcB, 0, 0, width, height, 1);
			ctx.restore();
		},
	},
	{
		type: "iris-circle",
		name: "Iris Circle Wipe",
		category: "wipe",
		description: "Khẩu độ ống kính tròn mở rộng từ tâm",
		defaultDuration: 0.6,
		render: (ctx, srcA, srcB, progress, { width, height }) => {
			drawSource(ctx, srcA, 0, 0, width, height, 1);
			const cx = width / 2;
			const cy = height / 2;
			const maxRadius = Math.hypot(width, height) / 2;
			const currentRadius = maxRadius * progress;
			ctx.save();
			ctx.beginPath();
			ctx.arc(cx, cy, currentRadius, 0, 2 * Math.PI);
			ctx.clip();
			drawSource(ctx, srcB, 0, 0, width, height, 1);
			ctx.restore();
		},
	},

	// ==========================================
	// 5. BLUR & GLITCH
	// ==========================================
	{
		type: "blur-dissolve",
		name: "Blur Dissolve",
		category: "glitch",
		description: "Làm mờ nhòe quang học ở giữa điểm giao nhau",
		defaultDuration: 0.5,
		render: (ctx, srcA, srcB, progress, { width, height }) => {
			const blurAmount = Math.sin(progress * Math.PI) * 14;
			ctx.save();
			if (blurAmount > 0.5 && "filter" in ctx) {
				ctx.filter = `blur(${blurAmount.toFixed(1)}px)`;
			}
			drawSource(ctx, srcA, 0, 0, width, height, 1 - progress);
			drawSource(ctx, srcB, 0, 0, width, height, progress);
			ctx.restore();
		},
	},
	{
		type: "rgb-glitch",
		name: "RGB Glitch Split",
		category: "glitch",
		description: "Nhiễu tín hiệu số và phân tách kênh màu RGB",
		defaultDuration: 0.45,
		render: (ctx, srcA, srcB, progress, { width, height }) => {
			const current = progress < 0.5 ? srcA : srcB;
			const intensity = Math.sin(progress * Math.PI);
			drawSource(ctx, current, 0, 0, width, height, 1);

			if (intensity > 0.1) {
				const numSlices = 6;
				const sliceH = height / numSlices;
				for (let i = 0; i < numSlices; i++) {
					const offset = (Math.sin(i * 12.3 + progress * 50) * intensity * 35);
					ctx.save();
					ctx.beginPath();
					ctx.rect(0, i * sliceH, width, sliceH);
					ctx.clip();
					drawSource(ctx, current, offset, 0, width, height, 0.7);
					ctx.restore();
				}
				// Chromatic tint bar
				ctx.save();
				ctx.globalCompositeOperation = "screen";
				ctx.fillStyle = `rgba(0, 255, 255, ${0.35 * intensity})`;
				ctx.fillRect(0, 0, width, height);
				ctx.restore();
			}
		},
	},
];
