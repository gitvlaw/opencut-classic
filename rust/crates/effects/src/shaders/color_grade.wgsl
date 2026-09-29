// Color grade shader — CapCut-style Adjust, single pass, sRGB direct.
// NOTE: pipeline works in sRGB (no linear decode) to stay compatible with
// existing blur/composite output. See pipeline.rs for data layout.
//
// data[] layout:
//   0 exposureEV [-3,+3]        1 brightness [-1,+1] (mapped from -100..100)
//   2 contrast [-1,+1]          3 saturation [-1,+1]
//   4 vibrance [-1,+1]          5 temperature [-1,+1]  6 tint [-1,+1]
//   7 highlights [-1,+1]        8 shadows [-1,+1]
//   9 whites [-1,+1]            10 blacks [-1,+1]
//   11 hueDeg [-180,+180]       12 fade [0,1]
//   13 sharpness [0,1] (reserved, no-op v1 — needs neighbor sampling)
//   14..63 reserved (0)

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

fn luma(c: vec3f) -> f32 {
    return dot(c, vec3f(0.2126, 0.7152, 0.0722));
}

fn white_balance(x: vec3f, temp: f32, tint: f32) -> vec3f {
    // Cheap LMS-style approx, tuned for sRGB direct.
    var y = x;
    y.r = y.r * (1.0 + temp * 0.12 - tint * 0.04);
    y.g = y.g * (1.0 + tint * 0.06);
    y.b = y.b * (1.0 - temp * 0.12 - tint * 0.04);
    return y;
}

fn tonal_region(mask_luma: f32, center: f32, width: f32) -> f32 {
    let d = (mask_luma - center) / width;
    return exp(-d * d);
}

fn shadows_highlights_shadows_whites(
    x: vec3f,
    highlights: f32,
    shadows: f32,
    whites: f32,
    blacks: f32,
) -> vec3f {
    let l = luma(x);
    let shadow_w = tonal_region(l, 0.2, 0.28);
    let highlight_w = tonal_region(l, 0.8, 0.28);
    let black_w = tonal_region(l, 0.05, 0.12);
    let white_w = tonal_region(l, 0.95, 0.12);
    var y = x;
    y = y + shadows * shadow_w * 0.35;
    y = y + highlights * highlight_w * 0.35;
    y = y + blacks * black_w * 0.45;
    y = y + whites * white_w * 0.45;
    return y;
}

fn hue_rotate(x: vec3f, deg: f32) -> vec3f {
    if (abs(deg) < 0.01) {
        return x;
    }
    let rad = radians(deg);
    let c = cos(rad);
    let s = sin(rad);
    // YIQ rotation matrix (hue only, luma-preserving approx).
    let r = 0.299 + 0.701 * c + 0.168 * s;
    let g = 0.587 - 0.587 * c + 0.330 * s;
    let b = 0.114 - 0.114 * c - 0.497 * s;
    let r2 = 0.299 - 0.299 * c - 0.328 * s;
    let g2 = 0.587 + 0.413 * c + 0.035 * s;
    let b2 = 0.114 - 0.114 * c + 0.292 * s;
    let r3 = 0.299 - 0.300 * c + 1.250 * s;
    let g3 = 0.587 - 0.588 * c - 1.050 * s;
    let b3 = 0.114 + 0.886 * c - 0.200 * s;
    return vec3f(
        x.r * r + x.g * g + x.b * b,
        x.r * r2 + x.g * g2 + x.b * b2,
        x.r * r3 + x.g * g3 + x.b * b3,
    );
}

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
    let src = textureSample(input_texture, input_sampler, input.tex_coord);
    let d = uniforms.data;

    var rgb = src.rgb * exp2(d[0]);
    rgb = white_balance(rgb, d[5], d[6]);
    rgb = (rgb - vec3f(0.5)) * (1.0 + d[2]) + vec3f(0.5) + vec3f(d[1]);
    rgb = shadows_highlights_shadows_whites(rgb, d[7], d[8], d[9], d[10]);

    let l = luma(rgb);
    rgb = mix(vec3f(l), rgb, 1.0 + d[3]);
    // Vibrance: scale saturation by inverse of existing saturation.
    let sat = max(max(rgb.r, rgb.g), rgb.b) - min(min(rgb.r, rgb.g), rgb.b);
    let vib_mask = clamp(1.0 - sat * 1.5, 0.0, 1.0);
    rgb = mix(vec3f(luma(rgb)), rgb, 1.0 + d[4] * (0.35 + 0.65 * vib_mask));

    rgb = hue_rotate(rgb, d[11]);
    rgb = mix(rgb, vec3f(luma(rgb)) * 0.5 + vec3f(0.25), clamp(d[12], 0.0, 1.0) * 0.55);
    rgb = clamp(rgb, vec3f(0.0), vec3f(1.0));

    return vec4f(rgb, src.a);
}
