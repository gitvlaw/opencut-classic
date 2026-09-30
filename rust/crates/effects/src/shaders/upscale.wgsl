// Resolution-change resampler. Renders the source into a different-size
// target (up or down). uniforms.resolution is the SOURCE size; the target
// size comes from the render target itself.
// data[] layout: 0 mode (0 = bilinear/hardware, 1 = bicubic Catmull-Rom,
// 2 = Lanczos-3). Bilinear relies on the linear sampler; the others fetch
// texels explicitly with nearest addressing baked into the math.

struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) tex_coord: vec2f,
}

struct EffectUniforms {
    resolution: vec2f,
    direction: vec2f,
    data: array<f32, 64>,
}

@group(0) @binding(0) var input_texture: texture_2d<f32>;
@group(0) @binding(1) var input_sampler: sampler;
@group(1) @binding(0) var<uniform> uniforms: EffectUniforms;

fn texel_fetch(px: vec2f) -> vec4f {
    let clamped = clamp(px + vec2f(0.5), vec2f(0.5), uniforms.resolution - vec2f(0.5));
    return textureSample(input_texture, input_sampler, clamped / uniforms.resolution);
}

fn catmull_rom_weights(t: f32) -> vec4f {
    let t2 = t * t;
    let t3 = t2 * t;
    return vec4f(
        -0.5 * t3 + t2 - 0.5 * t,
        1.5 * t3 - 2.5 * t2 + 1.0,
        -1.5 * t3 + 2.0 * t2 + 0.5 * t,
        0.5 * t3 - 0.5 * t2,
    );
}

fn sample_bicubic(p: vec2f) -> vec4f {
    let base = floor(p - vec2f(0.5)) + vec2f(0.5);
    let f = p - base;
    let wx = catmull_rom_weights(f.x);
    let wy = catmull_rom_weights(f.y);
    // Unrolled: dynamic vector indexing is unreliable on the WebGL path.
    let r0 = texel_fetch(base + vec2f(-1.0, -1.0)) * wx.x
        + texel_fetch(base + vec2f(0.0, -1.0)) * wx.y
        + texel_fetch(base + vec2f(1.0, -1.0)) * wx.z
        + texel_fetch(base + vec2f(2.0, -1.0)) * wx.w;
    let r1 = texel_fetch(base + vec2f(-1.0, 0.0)) * wx.x
        + texel_fetch(base + vec2f(0.0, 0.0)) * wx.y
        + texel_fetch(base + vec2f(1.0, 0.0)) * wx.z
        + texel_fetch(base + vec2f(2.0, 0.0)) * wx.w;
    let r2 = texel_fetch(base + vec2f(-1.0, 1.0)) * wx.x
        + texel_fetch(base + vec2f(0.0, 1.0)) * wx.y
        + texel_fetch(base + vec2f(1.0, 1.0)) * wx.z
        + texel_fetch(base + vec2f(2.0, 1.0)) * wx.w;
    let r3 = texel_fetch(base + vec2f(-1.0, 2.0)) * wx.x
        + texel_fetch(base + vec2f(0.0, 2.0)) * wx.y
        + texel_fetch(base + vec2f(1.0, 2.0)) * wx.z
        + texel_fetch(base + vec2f(2.0, 2.0)) * wx.w;
    return r0 * wy.x + r1 * wy.y + r2 * wy.z + r3 * wy.w;
}

fn sinc(x: f32) -> f32 {
    if (abs(x) < 0.0001) {
        return 1.0;
    }
    let pix = 3.14159265 * x;
    return sin(pix) / pix;
}

fn lanczos_weight(x: f32) -> f32 {
    if (abs(x) >= 3.0) {
        return 0.0;
    }
    return sinc(x) * sinc(x / 3.0);
}

fn sample_lanczos(p: vec2f) -> vec4f {
    let base = floor(p);
    var acc = vec4f(0.0, 0.0, 0.0, 0.0);
    var total = 0.0;
    for (var j = -2; j <= 3; j = j + 1) {
        for (var i = -2; i <= 3; i = i + 1) {
            let off = vec2f(f32(i), f32(j));
            let w = lanczos_weight(p.x - (base.x + off.x)) * lanczos_weight(p.y - (base.y + off.y));
            acc = acc + texel_fetch(base + off) * w;
            total = total + w;
        }
    }
    return acc / max(total, 0.0001);
}

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
    let mode = uniforms.data[0];
    if (mode < 0.5) {
        return textureSample(input_texture, input_sampler, input.tex_coord);
    }
    // Source-texel coordinates of this output pixel (center-based).
    let p = input.tex_coord * uniforms.resolution - vec2f(0.5);
    if (mode < 1.5) {
        return clamp(sample_bicubic(p), vec4f(0.0, 0.0, 0.0, 0.0), vec4f(1.0, 1.0, 1.0, 1.0));
    }
    return clamp(sample_lanczos(p), vec4f(0.0, 0.0, 0.0, 0.0), vec4f(1.0, 1.0, 1.0, 1.0));
}
