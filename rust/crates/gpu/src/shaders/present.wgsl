// Final presentation blit: copy + ordered dithering.
//
// 8-bit surfaces band on smooth gradients pushed by grading. Adding
// +/-0.5 LSB of decorrelated noise right before 8-bit quantization
// breaks banding into invisible dither. This runs ONLY on presentation
// (surface present / export readback) — never on internal copies, so
// multi-pass chains (blur, effects) don't accumulate noise.

struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) tex_coord: vec2f,
}

@group(0) @binding(0) var input_texture: texture_2d<f32>;
@group(0) @binding(1) var input_sampler: sampler;

fn hash12(p: vec2f) -> f32 {
    var p3 = fract(vec3f(p.xyx) * 0.1031);
    p3 = p3 + dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
    let src = textureSample(input_texture, input_sampler, input.tex_coord);
    let n = hash12(floor(input.position.xy)) - 0.5;
    return vec4f(src.rgb + vec3f(n) / 255.0, src.a);
}
