// Curves shader — per-channel 16-point LUT baked into uniforms.
// data[] layout: master y[0..15], red y[16..31], green y[32..47], blue y[48..63].
// Each value is output level 0..1 at input x = i/15. Linear interp between points.

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

fn sample_curve(x: f32, base: u32) -> f32 {
    let scaled = clamp(x, 0.0, 1.0) * 15.0;
    let idx = u32(min(floor(scaled), 14.0));
    let frac = scaled - f32(idx);
    let a = uniforms.data[base + idx];
    let b = uniforms.data[base + idx + 1u];
    return mix(a, b, frac);
}

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
    let src = textureSample(input_texture, input_sampler, input.tex_coord);
    let r = sample_curve(sample_curve(src.r, 0u), 16u);
    let g = sample_curve(sample_curve(src.g, 0u), 32u);
    let b = sample_curve(sample_curve(src.b, 0u), 48u);
    return vec4f(clamp(vec3f(r, g, b), vec3f(0.0), vec3f(1.0)), src.a);
}
