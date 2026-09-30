// Single-pass sharpen (3x3 Laplacian unsharp) in linear light.
// data[] layout: 0 amount [0,1] (UI sharpness 0..100 / 100).

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

fn srgb_to_linear(c: vec3f) -> vec3f {
    let lo = c / 12.92;
    let hi = pow((c + vec3f(0.055)) / vec3f(1.055), vec3f(2.4));
    return mix(hi, lo, vec3f(1.0) - step(vec3f(0.04045), c));
}

fn linear_to_srgb(c: vec3f) -> vec3f {
    let lo = c * 12.92;
    let hi = vec3f(1.055) * pow(max(c, vec3f(0.0)), vec3f(1.0 / 2.4)) - vec3f(0.055);
    return mix(hi, lo, vec3f(1.0) - step(vec3f(0.0031308), c));
}

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
    let src = textureSample(input_texture, input_sampler, input.tex_coord);
    let amount = clamp(uniforms.data[0], 0.0, 1.0) * 0.9;
    if (amount < 0.001) {
        return src;
    }
    let texel = vec2f(1.0, 1.0) / uniforms.resolution;
    var blurred = vec3f(0.0, 0.0, 0.0);
    for (var oy = -1; oy <= 1; oy = oy + 1) {
        for (var ox = -1; ox <= 1; ox = ox + 1) {
            let tap = textureSample(
                input_texture,
                input_sampler,
                input.tex_coord + texel * vec2f(f32(ox), f32(oy)),
            );
            blurred = blurred + srgb_to_linear(clamp(tap.rgb, vec3f(0.0), vec3f(1.0)));
        }
    }
    blurred = blurred / 9.0;
    let center = srgb_to_linear(clamp(src.rgb, vec3f(0.0), vec3f(1.0)));
    let sharpened = center + (center - blurred) * amount;
    return vec4f(clamp(linear_to_srgb(sharpened), vec3f(0.0), vec3f(1.0)), src.a);
}
