// Color wheels shader — Shadows / Midtones / Highlights balance.
// Camera Raw / Lumetri style: each zone has a hue/saturation tint plus a
// luminance offset, weighted by smooth tonal masks.
// data[] layout per zone (shadow, mid, high):
//   hueDeg [-180,+180], sat [0,1], lum [-1,+1]
//   shadow -> data[0..2], mid -> data[3..5], high -> data[6..8].

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

fn hue_to_rgb(p: f32, q: f32, t: f32) -> f32 {
    var tt = t;
    if (tt < 0.0) {
        tt = tt + 1.0;
    }
    if (tt > 1.0) {
        tt = tt - 1.0;
    }
    if (tt < 0.1666667) {
        return p + (q - p) * 6.0 * tt;
    }
    if (tt < 0.5) {
        return q;
    }
    if (tt < 0.6666667) {
        return p + (q - p) * (0.6666667 - tt) * 6.0;
    }
    return p;
}

fn hsl_to_rgb(h: f32, s: f32, l: f32) -> vec3f {
    let hh = h / 360.0;
    let ss = clamp(s, 0.0, 1.0);
    let ll = clamp(l, 0.0, 1.0);
    if (ss < 0.0001) {
        return vec3f(ll);
    }
    var q = ll;
    if (ll < 0.5) {
        q = ll * (1.0 + ss);
    } else {
        q = ll + ss - ll * ss;
    }
    let p = 2.0 * ll - q;
    return vec3f(
        hue_to_rgb(p, q, hh + 0.3333333),
        hue_to_rgb(p, q, hh),
        hue_to_rgb(p, q, hh - 0.3333333),
    );
}

fn zone_tint(hue_deg: f32, sat: f32) -> vec3f {
    var h = hue_deg % 360.0;
    if (h < 0.0) {
        h = h + 360.0;
    }
    return hsl_to_rgb(h, clamp(sat, 0.0, 1.0), 0.5) - vec3f(0.5);
}

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
    let src = textureSample(input_texture, input_sampler, input.tex_coord);
    let d = uniforms.data;

    let l = luma(src.rgb);
    let shadow_w = 1.0 - smoothstep(0.05, 0.55, l);
    let high_w = smoothstep(0.45, 0.95, l);
    let mid_w = clamp(1.0 - shadow_w - high_w, 0.0, 1.0);

    var rgb = src.rgb;
    rgb = rgb + (zone_tint(d[0], d[1]) * shadow_w + zone_tint(d[3], d[4]) * mid_w + zone_tint(d[6], d[7]) * high_w) * 0.6;
    rgb = rgb + (d[2] * shadow_w + d[5] * mid_w + d[8] * high_w) * 0.5;

    return vec4f(clamp(rgb, vec3f(0.0), vec3f(1.0)), src.a);
}
