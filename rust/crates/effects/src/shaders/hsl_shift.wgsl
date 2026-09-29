// HSL shift shader — 8 hue bands x (hue, sat, lum).
// data[] layout (normalized): per band i in 0..7:
//   data[i*3+0] hue shift [-1,+1] (mapped from -100..100, x180deg)
//   data[i*3+1] sat shift [-1,+1]
//   data[i*3+2] lum shift [-1,+1]
// Bands: 0 red, 1 orange, 2 yellow, 3 green, 4 cyan, 5 blue, 6 purple, 7 magenta.
// Band centers in hue degrees: 0, 30, 60, 120, 180, 240, 270, 315.

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

fn rgb_to_hsl(c: vec3f) -> vec3f {
    let mx = max(max(c.r, c.g), c.b);
    let mn = min(min(c.r, c.g), c.b);
    let l = (mx + mn) * 0.5;
    var h = 0.0;
    var s = 0.0;
    let d = mx - mn;
    if (d > 0.0001) {
        if (l < 0.5) {
            s = d / (mx + mn);
        } else {
            s = d / (2.0 - mx - mn);
        }
        if (mx == c.r) {
            h = (c.g - c.b) / d;
            if (c.g < c.b) {
                h = h + 6.0;
            }
        } else if (mx == c.g) {
            h = (c.b - c.r) / d + 2.0;
        } else {
            h = (c.r - c.g) / d + 4.0;
        }
        h = h * 60.0;
    }
    return vec3f(h, s, l);
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

fn hsl_to_rgb(hsl: vec3f) -> vec3f {
    let h = hsl.x / 360.0;
    let s = clamp(hsl.y, 0.0, 1.0);
    let l = clamp(hsl.z, 0.0, 1.0);
    if (s < 0.0001) {
        return vec3f(l);
    }
    var q = l;
    if (l < 0.5) {
        q = l * (1.0 + s);
    } else {
        q = l + s - l * s;
    }
    let p = 2.0 * l - q;
    return vec3f(
        hue_to_rgb(p, q, h + 0.3333333),
        hue_to_rgb(p, q, h),
        hue_to_rgb(p, q, h - 0.3333333),
    );
}

fn band_weight(hue: f32, center: f32) -> f32 {
    var d = abs(hue - center);
    d = min(d, 360.0 - d);
    // 22.5deg half-width with smooth falloff.
    return clamp(1.0 - d / 30.0, 0.0, 1.0);
}

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
    let src = textureSample(input_texture, input_sampler, input.tex_coord);
    // Fast path: all zeros -> identity.
    var hsl = rgb_to_hsl(src.rgb);
    var total_h = 0.0;
    var total_s = 0.0;
    var total_l = 0.0;
    var total_w = 0.0;
    for (var i = 0; i < 8; i = i + 1) {
        var center = 0.0;
        switch (i) {
            case 0: { center = 0.0; }
            case 1: { center = 30.0; }
            case 2: { center = 60.0; }
            case 3: { center = 120.0; }
            case 4: { center = 180.0; }
            case 5: { center = 240.0; }
            case 6: { center = 270.0; }
            default: { center = 315.0; }
        }
        let w = band_weight(hsl.x, center);
        total_h = total_h + uniforms.data[i * 3 + 0] * 180.0 * w;
        total_s = total_s + uniforms.data[i * 3 + 1] * w;
        total_l = total_l + uniforms.data[i * 3 + 2] * 0.5 * w;
        total_w = total_w + w;
    }
    if (total_w > 0.001) {
        hsl.x = hsl.x + total_h;
        if (hsl.x < 0.0) {
            hsl.x = hsl.x + 360.0;
        }
        if (hsl.x >= 360.0) {
            hsl.x = hsl.x - 360.0;
        }
        hsl.y = clamp(hsl.y * (1.0 + total_s) + total_s * 0.1, 0.0, 1.0);
        hsl.z = clamp(hsl.z + total_l, 0.0, 1.0);
    }
    return vec4f(clamp(hsl_to_rgb(hsl), vec3f(0.0), vec3f(1.0)), src.a);
}
