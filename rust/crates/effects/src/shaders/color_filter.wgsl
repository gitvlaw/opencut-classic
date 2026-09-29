// Procedural filter shader — preset look without LUT texture (WebGL-safe).
// data[] layout:
//   0 intensity [0,1]
//   1 warmth [-1,+1]   2 tint [-1,+1]
//   3 contrast [-1,+1] 4 saturation [-1,+1]
//   5 fade [0,1]       6 grain [0,1] (subtle mono grain, resolution-independent)
//   7 vignette [0,1]
//   8..16 color matrix 3x3 row-major (identity default)
//   17..19 lift rgb (added pre-matrix)
//   20..22 gain rgb (multiplied pre-matrix)

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

fn hash12(p: vec2f) -> f32 {
    var p3 = fract(vec3f(p.xyx) * 0.1031);
    p3 = p3 + dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
    let src = textureSample(input_texture, input_sampler, input.tex_coord);
    let d = uniforms.data;
    let intensity = clamp(d[0], 0.0, 1.0);
    if (intensity < 0.001) {
        return src;
    }

    var rgb = src.rgb * d[20] + vec3f(d[17], d[18], d[19]);
    // warmth/tint
    rgb.r = rgb.r * (1.0 + d[1] * 0.10);
    rgb.b = rgb.b * (1.0 - d[1] * 0.10);
    rgb.g = rgb.g * (1.0 + d[2] * 0.05);
    // 3x3 matrix
    let m0 = vec3f(d[8], d[9], d[10]);
    let m1 = vec3f(d[11], d[12], d[13]);
    let m2 = vec3f(d[14], d[15], d[16]);
    rgb = vec3f(dot(m0, rgb), dot(m1, rgb), dot(m2, rgb));
    // contrast + saturation
    rgb = (rgb - vec3f(0.5)) * (1.0 + d[3]) + vec3f(0.5);
    let l = dot(rgb, vec3f(0.2126, 0.7152, 0.0722));
    rgb = mix(vec3f(l), rgb, 1.0 + d[4]);
    rgb = mix(rgb, vec3f(l) * 0.5 + vec3f(0.25), clamp(d[5], 0.0, 1.0) * 0.5);
    // vignette
    let uv = input.tex_coord - vec2f(0.5);
    let vig = 1.0 - dot(uv, uv) * d[7] * 1.2;
    rgb = rgb * clamp(vig, 0.0, 1.0);
    // grain
    let g = (hash12(input.tex_coord * uniforms.resolution) - 0.5) * d[6] * 0.08;
    rgb = rgb + vec3f(g);

    rgb = clamp(rgb, vec3f(0.0), vec3f(1.0));
    return vec4f(mix(src.rgb, rgb, intensity), src.a);
}
