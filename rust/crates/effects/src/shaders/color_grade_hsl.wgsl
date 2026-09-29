// Fused Adjust + HSL shader — one pass instead of two.
// data[] layout: [0..13] color-grade params (see color_grade.wgsl),
// [14..15] padding, [16..39] HSL 8 bands x (hue, sat, lum) (see hsl_shift.wgsl).
// Emitted by TS fuseColorPassGroups() when an Adjust effect is immediately
// followed by an HSL effect. sRGB direct (see color_grade.wgsl note).

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

fn hue_rotate(x: vec3f, deg: f32) -> vec3f {
    if (abs(deg) < 0.01) {
        return x;
    }
    let rad = radians(deg);
    let c = cos(rad);
    let s = sin(rad);
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

fn band_weight(hue: f32, center: f32) -> f32 {
    var d = abs(hue - center);
    d = min(d, 360.0 - d);
    return clamp(1.0 - d / 30.0, 0.0, 1.0);
}

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
    let src = textureSample(input_texture, input_sampler, input.tex_coord);
    let d = uniforms.data;

    // --- grade ---
    var rgb = src.rgb * exp2(d[0]);
    rgb = white_balance(rgb, d[5], d[6]);
    rgb = (rgb - vec3f(0.5)) * (1.0 + d[2]) + vec3f(0.5) + vec3f(d[1]);
    let l0 = luma(rgb);
    rgb = rgb + d[8] * tonal_region(l0, 0.2, 0.28) * 0.35
        + d[7] * tonal_region(l0, 0.8, 0.28) * 0.35
        + d[10] * tonal_region(l0, 0.05, 0.12) * 0.45
        + d[9] * tonal_region(l0, 0.95, 0.12) * 0.45;
    let l1 = luma(rgb);
    rgb = mix(vec3f(l1), rgb, 1.0 + d[3]);
    let sat = max(max(rgb.r, rgb.g), rgb.b) - min(min(rgb.r, rgb.g), rgb.b);
    let vib_mask = clamp(1.0 - sat * 1.5, 0.0, 1.0);
    rgb = mix(vec3f(luma(rgb)), rgb, 1.0 + d[4] * (0.35 + 0.65 * vib_mask));
    rgb = hue_rotate(rgb, d[11]);
    rgb = mix(rgb, vec3f(luma(rgb)) * 0.5 + vec3f(0.25), clamp(d[12], 0.0, 1.0) * 0.55);
    rgb = clamp(rgb, vec3f(0.0), vec3f(1.0));

    // --- hsl (data base 16) ---
    var hsl = rgb_to_hsl(rgb);
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
        total_h = total_h + uniforms.data[16 + i * 3 + 0] * 180.0 * w;
        total_s = total_s + uniforms.data[16 + i * 3 + 1] * w;
        total_l = total_l + uniforms.data[16 + i * 3 + 2] * 0.5 * w;
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
