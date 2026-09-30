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

// Blur runs in linear light so midtones keep their energy (no dark halos);
// sRGB is decoded before and re-encoded after the kernel.
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
    let texel_size = vec2f(1.0, 1.0) / uniforms.resolution;
    let sigma = max(uniforms.data[0], 0.001);
    let step_size = max(uniforms.data[1], 1.0);

    var color = vec3f(0.0, 0.0, 0.0);
    var alpha = 0.0;
    var total_weight = 0.0;

    for (var index = -30; index <= 30; index = index + 1) {
        let position = f32(index) * step_size;
        let weight = exp(-(position * position) / (2.0 * sigma * sigma));
        let sample_uv = input.tex_coord + (texel_size * uniforms.direction * position);
        let tap = textureSample(input_texture, input_sampler, sample_uv);
        color = color + srgb_to_linear(clamp(tap.rgb, vec3f(0.0), vec3f(1.0))) * weight;
        alpha = alpha + tap.a * weight;
        total_weight = total_weight + weight;
    }

    return vec4f(clamp(linear_to_srgb(color / total_weight), vec3f(0.0), vec3f(1.0)), alpha / total_weight);
}
