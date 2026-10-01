# AUDIT KỸ THUẬT: AI UPSCALE KHI EXPORT

- **Dự án:** OpenCut
- **Bản gốc:** 30/09/2026 (audit Real-CUGAN 2x)
- **Cập nhật:** 01/10/2026 — chuyển sang **Real-ESRGAN x2plus**, đo lại toàn bộ tham số tiling, sửa lỗi đọc tensor.
- **Phạm vi:** `apps/web/src/upscale/`, `apps/web/src/services/renderer/scene-exporter.ts`, `apps/web/src/components/editor/export-button.tsx`, `rust/crates/effects/src/shaders/upscale.wgsl`

---

## 1. TỔNG QUAN

Upscale khung hình lúc export chạy hoàn toàn trong trình duyệt: Web Worker + **onnxruntime-web (WebGPU)**, tiling có feathering, bỏ qua khung hình tĩnh, fallback sang shader **Lanczos-3 WGSL** (`upscale.wgsl`, thuộc `rust/`).

**Model hiện tại: Real-ESRGAN x2plus** (`apps/web/public/models/real-esrgan-x2plus.onnx`, 64 MB, FP32, opset 14). Thay cho Real-CUGAN 2x (4.9 MB) — file CUGAN đã xoá khỏi repo vì không còn code nào tham chiếu.

### Vì sao không dùng Python sidecar

Đã cân nhắc chạy mô hình thật (torch/spandrel) qua localhost thay vì ONNX:
- Deploy web là Cloudflare Workers; gọi `http://127.0.0.1:8765` bị chặn mixed-content và CORS.
- `apps/desktop` mới chỉ là GPUI stub, repo không có tiền lệ IPC.
- Người dùng phải cài Python + torch (~2.5 GB) để dùng một tính năng editor.

→ Chốt ONNX + WebGPU trong worker.

---

## 2. EXPORT MODEL — quyết định quan trọng nhất

spandrel bọc `RRDBNet` trong một lớp ESRGAN có `pixel_unshuffle` và padding:

```python
def forward(self, x):
    true_scale = self.scale // self.shuffle_factor      # 2
    _, _, h, w = x.size()
    x = pad_to_multiple(x, self.shuffle_factor, mode="reflect")
    x = torch.pixel_unshuffle(x, downscale_factor=self.shuffle_factor)
    x = self.model(x)                                    # inner: scale 4
    return x[:, :, : h * true_scale, : w * true_scale]
```

**Không export được lớp wrapper.** `if pad_h or pad_w` là Python control flow trên kích thước tensor, bị `torch.onnx.export` constant-fold thành hằng số tại thời điểm trace. Đã kiểm chứng: graph export với dummy 256×256 **fail thật** khi đưa vào 255×255:

```
Reshape: Input shape {1,3,255,1,255}, requested shape {1,3,-1,2,255}
```

Chỉ nhận đúng kích thước lúc export — với tile mép có kích thước lẻ là hỏng ngay.

**Giải pháp:** export **lớp trong** (`net.model`) và đưa pad + unshuffle + crop sang TypeScript, nơi logic tường minh.

| | |
|---|---|
| Input graph | `[1, 12, h, w]`, `h`/`w` bất kỳ (`12 = 3 × 2²`) |
| Output graph | `[1, 3, 4h, 4w]` |
| Hệ số không gian tổng thể | `2^SHUFFLE / SHUFFLE = 2` |
| Ops | `Conv, Add, Mul, LeakyRelu, Concat, Resize` — toàn bộ WebGPU-supported |
| Kiểm chứng | max abs diff vs spandrel PyTorch ≈ **2e-6**, cả size chẵn lẫn lẻ |

Luồng worker cho mỗi tile (`apps/web/src/upscale/worker.ts`):

```
crop HWC từ frame  →  padHwcReflectInto tới bội số 2
                   →  packHwcToPixelUnshuffleInto  (3ch → 12ch, /2)
                   →  ONNX  →  đọc cửa sổ 2x với row stride = bề rộng ĐẦY ĐỦ
```

> Hệ số `2^SHUFFLE/SHUFFLE = 2` dễ sai: suy ra bằng `packed.height * 2 ** SHUFFLE` chứ **không** nhân `th * 2 ** SHUFFLE`, nếu không `assertNchwDims` sẽ ném exception ở mọi tile.

---

## 3. TILING — tham số cũ không dùng được cho Real-ESRGAN

Tham số cũ (`TILE_SIZE 256`, `OVERLAP 32`, `MARGIN 8`) chọn cho Real-CUGAN. Real-ESRGAN là **23 residual-in-dense block với dense connection** — receptive field rộng hơn hẳn.

### Đo thay vì suy đoán

Chạy full-frame làm chuẩn, nhúng phần lõi vào canvas đệm 0 rồi so số:

| margin | max err | mean err |
|---|---|---|
| 0 | 0 | 0 |
| 2 | 0.596 | 0.0024 |
| 8 | 0.531 | 0.0025 |
| 32 | 0.593 | 0.0036 |
| 64 | 0.120 | 0.0045 |

Sai số **tăng** theo margin — dấu hiệu receptive field phủ gần trọn ảnh, không phải hằng số nhỏ. Profile theo khoảng cách tới mép mới ra hình dạng thật:

| khoảng cách | mean err |
|---|---|
| 0–32px | 0.48 (rác) |
| 32–48px | 0.019 |
| 48–64px | 0.0074 |
| 64–96px | 0.0036 |
| 128–192px | 0.00048 |

### Kết quả sweep (PSNR so với full-frame, 1024×1024)

| tile | overlap | margin | tiles | PSNR |
|---|---|---|---|---|
| 256 | 64 | 16 | 25 | 49.83 dB |
| 256 | 128 | 48 | 49 | 54.63 dB |
| 512 | 128 | 48 | 9 | 61.24 dB |
| **512** | **160** | **64** | **9** | **66.77 dB** |
| 768 | 224 | 96 | 4 | 84.24 dB |

**Chốt: `TILE_SIZE 512`, `TILE_OVERLAP 160`, `TILE_MARGIN 64`** (blend band = 160 − 128 = 32px).

Margin lớn là chi phí **cố định theo pixel nguồn**, không phụ thuộc tile size — nên tile càng lớn vừa tốt hơn vừa ít lần inference hơn. Frame nhỏ tự clamp về 1 tile trong `computeTiles`.

Kiểm chứng trên khung thật (`TILE_MARGIN` không nuốt overlap):

| frame | tiles | minWgt | lỗ hổng | PSNR |
|---|---|---|---|---|
| 640×360 | 2 | 1.0000 | 0 | 79.01 dB |
| 1280×720 | 8 | 0.6000 | 0 | 68.03 dB |
| 1920×1080 | 15 | 0.3600 | 0 | 62.39 dB |

> Ngưỡng đọc: **> 55 dB** là khớp mắt thường; **< 40 dB** thấy rõ lưới ô. Margin 8 cũ chỉ đạt 41–49 dB — chính là lưới ô đã báo.

---

## 4. LỖI ĐỌC TENSOR — đã sửa, ảnh hưởng toàn bộ lịch sử tính năng

Vòng lặp cộng dồn đọc output NCHW planar bằng:

```ts
const o = (srcRow + x) * 3;              // ❌ nhân thừa 3
R = out[o], G = out[plane + o], B = out[2 * plane + o]
```

Với tensor planar, phần tử `(c, y, x)` nằm ở `c*plane + y*W + x` — **không có hệ số 3**.

Kiểm chứng bằng chính model CUGAN từng ship:

```
reads fell off end of buffer: 4095 (33.3%)
correct   mean RGB: [0.9498 0.2143 0.4176]
as-built  mean RGB: [0.5273 0.2106 0.1393]
as-built pixel (48,32): [0.4171 0.0000 0.0000]   correct: [0.9512 0.2186 0.4239]
```

**33.3% số lần đọc kênh rơi khỏi cuối buffer**, bị `?? 0` đổi thành đen. Kết quả: 1/3 trên cùng đúng màu, phần giữa sai, **1/3 dưới đen**.

→ Tính năng AI Upscale từ trước tới nay xuất ra ảnh sọc màu và đen một phần ba, không chỉ có seam. Đã sửa thành `const o = srcRow + x;` và có regression test trong `__tests__/tensor.test.ts`.

---

## 5. KIẾN TRÚC PIPELINE

### 5.1. Producer/consumer có giới hạn

`scene-exporter.ts` chạy pipeline sâu `PIPELINE_DEPTH = 3`: render khung $N+1$ (main thread) chồng với suy luận AI khung $N$ (worker) và nén $N-1$ (VideoEncoder). Hàng đợi có waiter list + cờ `producerDone`, `Promise.allSettled`.

Non-upscale vẫn dùng vòng lặp trực tiếp — không thêm chi phí khi không cần.

### 5.2. Chống lỗi & huỷ

| Vấn đề | Cách xử lý |
|---|---|
| Worker reset cờ huỷ mỗi job, khung kế tiếp lại chạy full inference | `cancelGeneration` chụp lúc enqueue, so với generation hiện tại |
| Main thread tạo worker mới sau `dispose()` | `service.ts` chốt generation khi huỷ/tháo |
| Một frame fail làm các frame sibling đang chờ abort cả export | `AiUpscaler.backendFailed` cho phép sibling fallback sang shader |
| Frame cũ hoàn tất sau frame mới ghi đè cache | `latestIssuedFrame` chỉ cho phép frame mới nhất ghi cache |
| Canvas 4K (~33 MB) cấp phát mỗi frame | Pool `readCanvas` / `resultCanvas` / `frameData`, chỉ cấp lại khi kích thước đổi |

### 5.3. Static-frame cache

Tính MAD trên ảnh xám thu nhỏ; khi trúng cache **không** cập nhật mốc so sánh → khung $N+k$ luôn so với khung AI thật gần nhất, triệt tiêu trôi màu tích luỹ.

Nhược điểm đã biết: phụ đề/con trỏ nhỏ có thể tạo `MAD ≈ 0.2–0.7` (dưới ngưỡng 1.5) và bị bỏ sót; `getImageData` đồng bộ trên main thread gây micro-stutter.

---

## 6. ĐỐI CHIẾU `AGENTS.md`

`AGENTS.md` yêu cầu mọi logic ngoài UI nằm ở `rust/`.

- **Shader upscaler:** tuân thủ — `upscale.wgsl` nằm trong `rust/crates/effects/src/shaders/`.
- **AI upscaler:** `tiling.ts`, `tensor.ts`, `worker.ts`, `service.ts` vẫn là TypeScript trong `apps/`.

Cần thừa nhận: đây là **nợ kiến trúc**. Lý do chưa chuyển: gọi WebGPU trong Web Worker bằng TS là chi tiết phụ thuộc nền tảng web, và `apps/desktop` chưa có tầng IPC. Khi Desktop được làm, phần thuật toán tiling/ghép ảnh (`tiling.rs`) nên tách ra crate chung để Web (qua WASM) và Desktop dùng lại. Phần này **chưa** nằm trong kế hoạch hiện tại.

---

## 7. ĐÃ SỬA XONG

| Mức | Vấn đề | Hiện trạng |
| :-- | :--- | :--- |
| P0 | Protocol mismatch `message.data` | Đã khớp `imageBitmap` |
| P0 | `scratchPool` không tồn tại | Đã thay bằng pool `scratch` tái sử dụng |
| P0 | **Đọc tensor planar sai hệ số 3 → 1/3 ảnh đen** | Đã sửa + regression test |
| P0 | **Graph ONNX constant-fold, chỉ nhận 1 kích thước** | Export lớp trong; pad/unshuffle sang TS |
| P1 | Rò rỉ `OffscreenCanvas` 4K | Pool canvas + buffer |
| P1 | Retry AI vô ích sau lỗi phần cứng | `backendFailed` fallback vĩnh viễn |
| P1 | Viền méo mép tile (lưới ô) | Margin 8 → 64, overlap 32 → 160: **62.4 dB** |
| P1 | Huỷ không dừng được frame đang chờ | `cancelGeneration` hai chiều |
| P2 | Pipeline tuần tự, GPU nhàn rỗi | Producer/consumer `PIPELINE_DEPTH = 3` |
| P2 | Xung đột Radio/Checkbox AI | Đồng bộ qua một cơ chế chọn |
| P2 | Chặn fallback WASM CPU | Từ chối, bắt buộc dùng Lanczos |

Kiểm chứng hiện tại: **43 test pass**, typecheck `upscale|scene-exporter` sạch, mô phỏng end-to-end bằng đúng file ONNX đang ship cho PSNR 68–79 dB với 0 lỗ hổng và mean RGB khớp full-frame.

---

## 8. RỦI RO CÒN LẠI

### P0 — chưa kiểm chứng trên trình duyệt

**Chưa chạy WebGPU thật.** Toàn bộ số đo trên dùng PyTorch/onnxruntime CPU trên RTX 4060. Còn rủi ro:

1. **Bộ nhớ.** Tile 512×512 nặng hơn 256. `MAX_OUTPUT_PIXELS = 48M` cho phép tới 4K, cộng dồn `acc` + `weights` ở 4K đã là ~400 MB; chưa biết thêm activation của RRDBNet có vừa VRAM trên máy 6–8 GB không.
2. **Tốc độ.** Full-frame 1080p ~1.7 s/frame trên RTX 4060; WebGPU thường chậm hơn vài lần. Chưa biết thời gian export thực tế.
3. **Kernel fallback.** `Resize` + `LeakyRelu` trên WebGPU: cần xác nhận không rơi về shader interpreter.

Cần chạy thử export thật trên Chrome/Edge có WebGPU trước khi coi tính năng là dùng được.

### P1 — chưa làm

- **Thanh tiến trình tải model.** Model giờ **64 MB** (nặng hơn nhiều lần so với 5 MB của CUGAN). Worker có `tile_progress` nhưng `scene-exporter.ts` chưa nhận callback; người dùng sẽ thấy thanh export đứng 0% suốt lúc tải model.
- **Test concurrency.** Producer/consumer, `cancelGeneration`, `backendFailed` chưa có test riêng — hiện chỉ kiểm bằng typecheck và mô phỏng.
- **Kiểm thử `padHwcReflectInto` aliasing** đã có test, nhưng đường padding trong worker chưa chạy với tile thật trên trình duyệt.

### P2 — đã biết

- `getImageData` đồng bộ trên main thread mỗi khung hình.
- Ngưỡng static-frame cache bỏ sót thay đổi nhỏ (phụ đề, con trỏ).

---

## 9. TÁI TẠO SỐ ĐO

Script dùng để chọn tham số (trong thư mục temp, không commit):

| Script | Việc |
| :--- | :--- |
| `export_inner.py` | Export + verify graph (mọi kích thước) + đối chiếu spandrel |
| `measure_rf.py` | Sai số so với full-frame theo margin |
| `measure_rf2.py` | Profile sai số theo khoảng cách tới mép |
| `sweep_tiles.py` | Sweep tile/overlap/margin, chấm PSNR |
| `validate_config.py` | Xác nhận config cuối trên 1920×1080 |
| `check_indexing.py` | Chứng minh lỗi đọc planar (chạy trên CUGAN cũ) |
| `e2e_worker_sim.py` | Mô phỏng vòng lặp worker với file ONNX đang ship |

Yêu cầu môi trường: torch/spandrel nằm ở `.venv` của watermark-removal-tool; `onnx` và `onnxruntime` chỉ có ở global Python. Nối `sys.path` (append, không prepend) để dùng chung mà không cài gì.
