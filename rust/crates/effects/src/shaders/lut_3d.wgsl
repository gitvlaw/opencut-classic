// True 3D LUT shader over a 2D Hald-style strip texture.
// Strip layout (built by TS hald.ts): width = N*N, height = N,
// pixel (x = b*N + r, y = g) holds LUT entry (r, g, b).
// data[] layout: 0 intensity [0,1], 1 LUT size N, 2 LUT registry id.

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
@group(2) @binding(0) var lut_texture: texture_2d<f32>;
@group(2) @binding(1) var lut_sampler: sampler;

fn lut_fetch(r: f32, g: f32, b: f32, n: f32) -> vec3f {
    let uv = vec2((b * n + r + 0.5) / (n * n), (g + 0.5) / n);
    return textureSample(lut_texture, lut_sampler, uv).rgb;
}

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
    let src = textureSample(input_texture, input_sampler, input.tex_coord);
    let intensity = clamp(uniforms.data[0], 0.0, 1.0);
    if (intensity < 0.001) {
        return src;
    }
    let n = max(uniforms.data[1], 2.0);
    let base = clamp(src.rgb, vec3f(0.0), vec3f(1.0)) * (n - 1.0);
    let p0 = floor(base);
    let p1 = min(p0 + vec3f(1.0), vec3f(n - 1.0));
    let f = base - p0;

    let c000 = lut_fetch(p0.r, p0.g, p0.b, n);
    let c100 = lut_fetch(p1.r, p0.g, p0.b, n);
    let c010 = lut_fetch(p0.r, p1.g, p0.b, n);
    let c110 = lut_fetch(p1.r, p1.g, p0.b, n);
    let c001 = lut_fetch(p0.r, p0.g, p1.b, n);
    let c101 = lut_fetch(p1.r, p0.g, p1.b, n);
    let c011 = lut_fetch(p0.r, p1.g, p1.b, n);
    let c111 = lut_fetch(p1.r, p1.g, p1.b, n);

    let c00 = mix(c000, c100, f.r);
    let c10 = mix(c010, c110, f.r);
    let c01 = mix(c001, c101, f.r);
    let c11 = mix(c011, c111, f.r);
    let c0 = mix(c00, c10, f.g);
    let c1 = mix(c01, c11, f.g);
    let graded = mix(c0, c1, f.b);

    return vec4f(mix(src.rgb, clamp(graded, vec3f(0.0), vec3f(1.0)), intensity), src.a);
}
